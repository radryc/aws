import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { dockerImage } from './docker-assets';
import { SentinelDefaultAlarms } from './sentinel-alarms';

export interface AwsObservedPusherStackProps extends cdk.StackProps {
  /** Guardian pusher name. Defaults to aws-<account>. */
  pusherName?: string;
  /** Existing VPC. When omitted the stack creates a small public-subnet VPC. */
  vpc?: ec2.IVpc;
  /** Expose the read API on an internet-facing ALB. Default true. */
  exposeOnAlb?: boolean;
  /** Optional existing ALB listener to attach /v1/aws/* to. */
  albListener?: elb.ApplicationListener;
  /** Fargate task size. */
  cpu?: number;
  memoryLimitMiB?: number;
  /** CloudWatch log retention in days. Default 14. */
  logRetentionDays?: number;
  /**
   * SSM prefix containing customer onboarding descriptors. Empty disables
   * onboarding discovery.
   */
  onboardingSsmPrefix?: string;
  /** Add a CloudWatch agent sidecar for pusher probe telemetry. Default true. */
  cloudWatchAgent?: boolean;
  /** Override the CloudWatch agent image. */
  cloudWatchAgentImage?: string;
  /**
   * Container image for the pusher. Defaults to building from the Strata
   * checkout at repoRoot. Set this to a published guardian-pusher-aws image
   * (for example from ECR) when the construct lives in another repository.
   */
  image?: ecs.ContainerImage;
  /**
   * Path to a checkout that contains `docker/`. Defaults to this repo root.
   * Override when embedding this stack in another CDK app.
   */
  repoRoot?: string;
}

/**
 * Self-contained AWS observed pusher. It runs `guardian-pusher-aws
 * --observed-only` (no MonoFS dependency), consumes CloudFormation
 * EventBridge events from SQS and serves the observed read API that Guardian
 * pulls from. Drop this construct into any CDK app to enable observed intents
 * for an account.
 */
export class AwsObservedPusherStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AwsObservedPusherStackProps = {}) {
    super(scope, id, props);

    const accountId = this.account;
    const region = this.region;
    const pusherName = props.pusherName ?? `aws-${accountId}`;

    const vpc =
      props.vpc ??
      new ec2.Vpc(this, 'ObservedPusherVpc', {
        maxAzs: 2,
        natGateways: 0,
        subnetConfiguration: [{ name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
      });

    const cluster = new ecs.Cluster(this, 'ObservedPusherCluster', { vpc });

    const logGroup = new logs.LogGroup(this, 'ObservedPusherLogGroup', {
      logGroupName: `/ecs/guardian-observed-pusher`,
      retention: retention(props.logRetentionDays),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const logDriver = ecs.LogDrivers.awsLogs({ streamPrefix: 'guardian-observed-pusher', logGroup });

    const execRole = new iam.Role(this, 'ObservedPusherExecRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    const readToken = new secretsmanager.Secret(this, 'ObservedReadToken', {
      secretName: `strata/guardian/observed-read-token-${pusherName}`,
      description: 'Bearer token for the observed pusher read API',
      generateSecretString: { excludePunctuation: true, passwordLength: 48 },
    });
    readToken.grantRead(execRole);

    const observeDlq = new sqs.Queue(this, 'ObservedEventsDlq', {
      queueName: `guardian-observed-events-dlq-${pusherName}`,
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });
    const observeQueue = new sqs.Queue(this, 'ObservedEventsQueue', {
      queueName: `guardian-observed-events-${pusherName}`,
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
      visibilityTimeout: cdk.Duration.seconds(120),
      deadLetterQueue: { queue: observeDlq, maxReceiveCount: 3 },
    });
    const rule = new events.Rule(this, 'CloudFormationEvents', {
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

    const taskRole = new iam.Role(this, 'ObservedPusherTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess')],
    });
    observeQueue.grantConsumeMessages(taskRole);
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'cloudformation:GetTemplate',
          'cloudformation:DetectStackDrift',
          'cloudformation:DescribeStackDriftDetectionStatus',
          'cloudformation:DescribeStackResourceDrifts',
          'ssm:GetParameter',
          'ssm:GetParameters',
          'ssm:GetParametersByPath',
          'cloudwatch:DescribeAlarms',
          'cloudwatch:DescribeAlarmHistory',
          'cloudwatch:ListTagsForResource',
        ],
        resources: ['*'],
      }),
    );
    if (props.cloudWatchAgent ?? true) {
      taskRole.addToPolicy(
        new iam.PolicyStatement({
          actions: [
            'cloudwatch:PutMetricData',
            'logs:CreateLogGroup',
            'logs:CreateLogStream',
            'logs:PutLogEvents',
            'xray:PutTraceSegments',
            'xray:PutTelemetryRecords',
          ],
          resources: ['*'],
        }),
      );
    }

    const taskDef = new ecs.FargateTaskDefinition(this, 'ObservedPusherTask', {
      family: `guardian-observed-pusher-${pusherName}`,
      cpu: props.cpu ?? 512,
      memoryLimitMiB: props.memoryLimitMiB ?? 1024,
      executionRole: execRole,
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const onboardingPrefix = (props.onboardingSsmPrefix ?? '/guardian/onboarding').replace(/\/+$/, '');
    const agentEnabled = props.cloudWatchAgent ?? true;
    const pusherCommand =
      'exec /usr/local/bin/guardian-pusher-aws ' +
      '--observed-only ' +
      `--pusher-name=${pusherName} ` +
      `--account=${accountId} ` +
      `--region=${region} ` +
      '--assume-role-name= ' +
      '--awsread-addr=:19090 ' +
      '--events-queue-url="$GUARDIAN_AWS_EVENTS_QUEUE_URL" ' +
      `--onboarding-ssm-prefix=${onboardingPrefix} ` +
      '--aws-state-dir=/var/lib/guardian/pusher-aws';

    taskDef.addContainer('guardian-pusher-aws', {
      image:
        props.image ??
        dockerImage('guardian-pusher-aws.Dockerfile', { repoRoot: props.repoRoot }),
      logging: logDriver,
      entryPoint: ['/bin/sh', '-c'],
      command: [pusherCommand],
      portMappings: [{ name: 'guardian-awsread', containerPort: 19090, protocol: ecs.Protocol.TCP }],
      environment: {
        GUARDIAN_AWS_EVENTS_QUEUE_URL: observeQueue.queueUrl,
        GUARDIAN_AWSREAD_ADDR: ':19090',
        ...(agentEnabled ? {
          GUARDIAN_OTEL_ENDPOINT: 'http://localhost:4317',
          GUARDIAN_OTEL_INSECURE: 'true',
        } : {}),
      },
      secrets: {
        GUARDIAN_AWSREAD_TOKEN: ecs.Secret.fromSecretsManager(readToken),
      },
    });

    if (agentEnabled) {
      taskDef.addContainer('cloudwatch-agent', {
        image: ecs.ContainerImage.fromRegistry(
          props.cloudWatchAgentImage ?? 'public.ecr.aws/cloudwatch-agent/cloudwatch-agent:latest',
        ),
        essential: false,
        environment: {
          CW_CONFIG_CONTENT: JSON.stringify({
            agent: { region },
            opentelemetry: {
              resource_attributes: {
                'guardian.pusher': pusherName,
                'guardian.account': accountId,
                'guardian.region': region,
              },
              collect: {
                otlp: {
                  grpc_endpoint: '0.0.0.0:4317',
                  http_endpoint: '0.0.0.0:4318',
                },
              },
            },
          }),
        },
        logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'cloudwatch-agent' }),
      });
    }

    const serviceSg = new ec2.SecurityGroup(this, 'ObservedPusherSg', {
      vpc,
      description: 'Guardian observed pusher',
    });

    const service = new ecs.FargateService(this, 'ObservedPusherSvc', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      securityGroups: [serviceSg],
      vpcSubnets: props.vpc ? undefined : { subnetType: ec2.SubnetType.PUBLIC },
      assignPublicIp: props.vpc ? false : true,
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      circuitBreaker: { rollback: true },
    });

    const policyDeps = [execRole, taskRole]
      .map((r) => r.node.tryFindChild('DefaultPolicy'))
      .filter((c): c is Construct => c !== undefined);
    if (policyDeps.length > 0) {
      service.node.addDependency(...policyDeps);
    }

    new SentinelDefaultAlarms(this, 'SentinelDefaultAlarms', {
      pusherName,
      partition: (this.node.tryGetContext('sentinelPartition') as string | undefined)?.trim(),
      service,
      queue: observeQueue,
      dlq: observeDlq,
    });

    const exposeOnAlb = props.exposeOnAlb ?? true;
    let albUrl: string | undefined;
    if (exposeOnAlb) {
      const listener =
        props.albListener ??
        (() => {
          const alb = new elb.ApplicationLoadBalancer(this, 'ObservedPusherAlb', {
            vpc,
            internetFacing: true,
          });
          return alb.addListener('Http', {
            port: 80,
            open: true,
            defaultAction: elb.ListenerAction.fixedResponse(404, {
              contentType: 'text/plain',
              messageBody: 'not found',
            }),
          });
        })();
      listener.addTargets('ObservedReadTarget', {
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
        targets: [service.loadBalancerTarget({ containerName: 'guardian-pusher-aws', containerPort: 19090 })],
      });
      serviceSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(19090), 'ALB to observed read API');
      albUrl = `http://${listener.loadBalancer.loadBalancerDnsName}`;
    }

    new cdk.CfnOutput(this, 'PusherName', { value: pusherName });
    new cdk.CfnOutput(this, 'OnboardingSsmPrefix', { value: onboardingPrefix });
    new cdk.CfnOutput(this, 'AwsObserveQueueUrl', { value: observeQueue.queueUrl });
    new cdk.CfnOutput(this, 'AwsReadTokenSecretArn', { value: readToken.secretArn });
    new cdk.CfnOutput(this, 'AwsReadServiceConnectAddress', {
      value: 'guardian-awsread:19090',
      description: 'Set the Guardian pusher observedApiUrl to this when co-located',
    });
    new cdk.CfnOutput(this, 'EcsClusterName', { value: cluster.clusterName });
    new cdk.CfnOutput(this, 'EcsServiceName', { value: service.serviceName });
    if (albUrl) {
      new cdk.CfnOutput(this, 'AwsReadApiUrl', {
        value: albUrl,
        description: 'Set the Guardian pusher observedApiUrl to this host (/v1/aws/* routes to the read API)',
      });
    }
  }
}

function retention(days?: number): logs.RetentionDays {
  if (!days || days <= 1) return logs.RetentionDays.ONE_DAY;
  if (days <= 3) return logs.RetentionDays.THREE_DAYS;
  if (days <= 7) return logs.RetentionDays.ONE_WEEK;
  if (days <= 14) return logs.RetentionDays.TWO_WEEKS;
  if (days <= 30) return logs.RetentionDays.ONE_MONTH;
  return logs.RetentionDays.THREE_MONTHS;
}
