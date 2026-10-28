import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct, IConstruct } from 'constructs';
import { dockerImage } from './docker-assets';

export interface AwsPusherStackProps extends cdk.StackProps {
  /** Network + cluster from the main Strata stack. */
  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  serviceConnectNamespace: servicediscovery.INamespace;
  monofsSg: ec2.ISecurityGroup;
  vpcSubnets: ec2.SubnetSelection;
  /** MonoFS break-glass token secret (read by the pusher). */
  monofsToken: secretsmanager.ISecret;
  /** Router service to wait for before the pusher dials it. */
  monofsRouterSvc?: IConstruct;
  /** Main Strata ALB + listener, used to expose the read API to Doctor. */
  alb?: elb.IApplicationLoadBalancer;
  albListener?: elb.IApplicationListener;
}

/**
 * AWS pusher deployed as its own CloudFormation stack. It joins the main
 * Strata stack's VPC / ECS cluster / Service Connect namespace and scans the
 * account (read-only) and runs CDK deploys.
 */
export class AwsPusherStack extends cdk.Stack {
  /** Read API token for Doctor federation. */
  public readonly readToken: secretsmanager.Secret;
  /** Service Connect DNS for the read API. */
  public readonly readServiceDNS = 'guardian-awsread';

  constructor(scope: Construct, id: string, props: AwsPusherStackProps) {
    super(scope, id, props);

    const accountId = this.account;
    const region = this.region;
    const pusherName = (this.node.tryGetContext('pusherName') as string) || `aws-${accountId}`;

    const docker = (file: string) => dockerImage(file);

    const logGroup = new logs.LogGroup(this, 'AwsPusherLogGroup', {
      logGroupName: '/ecs/strata-pusher',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const logDriver = ecs.LogDrivers.awsLogs({ streamPrefix: 'strata-pusher', logGroup });

    const execRole = new iam.Role(this, 'AwsPusherExecRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });
    props.monofsToken.grantRead(execRole);
    execRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        resources: [
          `arn:aws:secretsmanager:${region}:${accountId}:secret:strata/monofs/token*`,
        ],
      }),
    );

    // Bearer token for the read-only CloudWatch/X-Ray API. Generated here so
    // enabling an account provisions auth automatically.
    const readToken = new secretsmanager.Secret(this, 'AwsReadToken', {
      secretName: 'strata/guardian/awsread-token',
      description: 'Bearer token for the guardian-pusher-aws read-only CloudWatch/X-Ray API',
      generateSecretString: { excludePunctuation: true, passwordLength: 48 },
    });
    readToken.grantRead(execRole);
    this.readToken = readToken;

    const taskRole = new iam.Role(this, 'AwsPusherTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess')],
    });
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'cloudformation:ListTypes',
          'cloudcontrol:ListResources',
          'cloudcontrol:ListResourceRequests',
          'ec2:DescribeRegions',
        ],
        resources: ['*'],
      }),
    );
    // Read-only observability surface exposed to Doctor: CloudWatch metrics,
    // CloudWatch Logs Insights and X-Ray.
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'cloudwatch:GetMetricData',
          'cloudwatch:GetMetricStatistics',
          'cloudwatch:ListMetrics',
          'logs:DescribeLogGroups',
          'logs:StartQuery',
          'logs:GetQueryResults',
          'logs:StopQuery',
          'xray:GetServiceGraph',
          'xray:GetTraceSummaries',
          'xray:BatchGetTraces',
        ],
        resources: ['*'],
      }),
    );

    // EventBridge -> SQS observation pipeline. CloudFormation stack status and
    // drift detection events land on the queue; the pusher consumes them,
    // maintains its observed-state cache and serves it over the read API.
    // Disable with `-c deployAwsObserve=false`.
    const deployObserve = this.node.tryGetContext('deployAwsObserve') ?? true;
    let observeQueue: sqs.Queue | undefined;
    if (deployObserve) {
      const observeDlq = new sqs.Queue(this, 'AwsObserveDlq', {
        queueName: 'guardian-aws-observe-dlq',
        retentionPeriod: cdk.Duration.days(14),
        enforceSSL: true,
      });
      observeQueue = new sqs.Queue(this, 'AwsObserveQueue', {
        queueName: 'guardian-aws-observe',
        retentionPeriod: cdk.Duration.days(14),
        enforceSSL: true,
        visibilityTimeout: cdk.Duration.seconds(120),
        deadLetterQueue: { queue: observeDlq, maxReceiveCount: 3 },
      });
      const rule = new events.Rule(this, 'AwsCloudFormationEvents', {
        description: 'CloudFormation stack + drift events for Guardian observed intents',
        eventPattern: {
          source: ['aws.cloudformation'],
          detailType: [
            'CloudFormation Stack Status Change',
            'CloudFormation Drift Detection Status Change',
          ],
        },
      });
      rule.addTarget(new targets.SqsQueue(observeQueue));
      observeQueue.grantConsumeMessages(taskRole);
      // The read API refreshes observed state on demand, so the task role needs
      // template reads and drift detection on top of ReadOnlyAccess.
      taskRole.addToPolicy(
        new iam.PolicyStatement({
          actions: [
            'cloudformation:GetTemplate',
            'cloudformation:DetectStackDrift',
            'cloudformation:DescribeStackDriftDetectionStatus',
            'cloudformation:DescribeStackResourceDrifts',
          ],
          resources: ['*'],
        }),
      );
    }

    const taskDef = new ecs.FargateTaskDefinition(this, 'AwsPusherTask', {
      family: 'guardian-pusher-aws',
      memoryLimitMiB: 2048,
      cpu: 1024,
      executionRole: execRole,
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const pusherScript =
      'exec /usr/local/bin/guardian-pusher-aws ' +
      `--pusher-name=${pusherName} ` +
      `--account=${accountId} ` +
      `--region=${region} ` +
      '--monofs-router=monofs-router:9090 ' +
      '--monofs-token="$GUARDIAN_MONOFS_TOKEN" ' +
      '--assume-role-name= ' +
      '--cdk-binary=cdk ' +
      '--aws-state-dir=/var/lib/guardian/pusher-aws ' +
      '--bootstrap-stack-name=CDKToolkit ' +
      '--cfn-execution-role=per-intent';

    taskDef.addContainer('guardian-pusher-aws', {
      image: docker('guardian-pusher-aws.Dockerfile'),
      logging: logDriver,
      entryPoint: ['/bin/sh', '-c'],
      command: [pusherScript],
      portMappings: [{ name: 'guardian-awsread', containerPort: 19090, protocol: ecs.Protocol.TCP }],
      environment: {
        GUARDIAN_PUSHER_NAME: pusherName,
        GUARDIAN_ACCOUNT: accountId,
        GUARDIAN_REGION: region,
        GUARDIAN_AWSREAD_ADDR: ':19090',
        ...(observeQueue ? { GUARDIAN_AWS_EVENTS_QUEUE_URL: observeQueue.queueUrl } : {}),
      },
      secrets: {
        GUARDIAN_MONOFS_TOKEN: ecs.Secret.fromSecretsManager(props.monofsToken),
        GUARDIAN_AWSREAD_TOKEN: ecs.Secret.fromSecretsManager(readToken),
      },
    });

    const svc = new ecs.FargateService(this, 'AwsPusherSvc', {
      cluster: props.cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      securityGroups: [props.monofsSg],
      vpcSubnets: props.vpcSubnets,
      assignPublicIp: false,
      serviceConnectConfiguration: {
        namespace: props.serviceConnectNamespace.namespaceName,
        services: [
          {
            portMappingName: 'guardian-awsread',
            dnsName: 'guardian-awsread',
            port: 19090,
          },
        ],
      },
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      circuitBreaker: { rollback: true },
    });
    svc.node.addDependency(props.serviceConnectNamespace);
    if (props.monofsRouterSvc) {
      svc.node.addDependency(props.monofsRouterSvc);
    }

    // Ordering guard: create IAM policies before the service so Fargate can
    // fetch secrets on first task start.
    const policyDeps = [execRole, taskRole]
      .map((r) => r.node.tryFindChild('DefaultPolicy'))
      .filter((c): c is Construct => c !== undefined);
    if (policyDeps.length > 0) {
      svc.node.addDependency(...policyDeps);
    }

    // Expose the read API through the main Strata ALB at /v1/aws/* so Doctor
    // (running outside this ECS cluster) can reach it. Disable with
    // `-c exposeAwsReadOnAlb=false`.
    const exposeOnAlb = this.node.tryGetContext('exposeAwsReadOnAlb') ?? true;
    if (exposeOnAlb && props.alb && props.albListener) {
      props.albListener.addTargets('AwsReadTarget', {
        port: 19090,
        protocol: elb.ApplicationProtocol.HTTP,
        priority: 5,
        conditions: [elb.ListenerCondition.pathPatterns(['/v1/aws/*'])],
        healthCheck: {
          path: '/healthz',
          port: '19090',
          interval: cdk.Duration.seconds(30),
          healthyHttpCodes: '200',
        },
        targets: [svc.loadBalancerTarget({ containerName: 'guardian-pusher-aws', containerPort: 19090 })],
      });
      props.alb.connections.allowTo(svc, ec2.Port.tcp(19090), 'ALB to guardian aws read API');
    }

    new cdk.CfnOutput(this, 'AwsReadServiceConnectAddress', {
      value: 'guardian-awsread:19090',
      description: 'In-cluster Service Connect address of the CloudWatch/X-Ray read API',
    });
    new cdk.CfnOutput(this, 'PusherName', {
      value: pusherName,
      description: 'Guardian pusher name to register (guardianctl pusher add --name)',
    });
    new cdk.CfnOutput(this, 'AwsReadTokenSecretArn', {
      value: readToken.secretArn,
      description: 'Secrets Manager ARN holding the read API bearer token',
    });
    if (observeQueue) {
      new cdk.CfnOutput(this, 'AwsObserveQueueUrl', {
        value: observeQueue.queueUrl,
        description: 'SQS queue carrying CloudFormation stack + drift events to the pusher',
      });
    }
    if (props.alb) {
      new cdk.CfnOutput(this, 'AwsReadApiUrl', {
        value: `http://${props.alb.loadBalancerDnsName}`,
        description: 'Set DOCTOR_AWS_BACKEND_URL to this (/v1/aws/* on the Strata ALB routes to the read API)',
      });
    }
  }
}
