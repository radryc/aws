import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct, IConstruct } from 'constructs';
import { dockerImage } from './docker-assets';
import { SentinelDefaultAlarms } from './sentinel-alarms';

export interface AwsPusherFleetStackProps extends cdk.StackProps {
  /** Network + cluster from the main Strata stack (tools account). */
  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  serviceConnectNamespace: servicediscovery.INamespace;
  monofsSg: ec2.ISecurityGroup;
  vpcSubnets: ec2.SubnetSelection;
  /** MonoFS break-glass token secret (read by the pushers). */
  monofsToken: secretsmanager.ISecret;
  /** Router service to wait for before the pushers dial it. */
  monofsRouterSvc?: IConstruct;
  /** Target AWS account ids; one pusher service is created per account. */
  targetAccounts: string[];
  /** Deploy role name assumed in each target account. */
  assumeRoleName?: string;
  /** Region used for the pushers (defaults to the stack region). */
  pusherRegion?: string;
}

/**
 * Multi-account pusher fleet: one ECS service per target AWS account on the
 * main Strata cluster. Each service assumes `GuardianCdkDeployRole` in its
 * target account (grant that trust with
 * `guardianctl aws setup --trust-principal <fleet-task-role-arn>`), pushes to
 * the `aws-<account>` queue and serves its observed read API on
 * `guardian-awsread-<index>:19090` through Service Connect.
 */
export class AwsPusherFleetStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AwsPusherFleetStackProps) {
    super(scope, id, props);

    const region = props.pusherRegion || this.region;
    const assumeRoleName = props.assumeRoleName || 'GuardianCdkDeployRole';
    const accounts = (props.targetAccounts || []).map((value) => value.trim()).filter((value) => value !== '');
    if (accounts.length === 0) {
      throw new Error('AwsPusherFleetStack requires at least one target account (-c fleetTargetAccounts=id1,id2)');
    }

    const image = dockerImage('guardian-pusher-aws.Dockerfile');

    const execRole = new iam.Role(this, 'FleetExecRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });
    props.monofsToken.grantRead(execRole);

    accounts.forEach((accountId, index) => {
      const suffix = accountId;
      const pusherName = `aws-${accountId}`;
      const dnsName = `guardian-awsread-${index + 1}`;

      const logGroup = new logs.LogGroup(this, `FleetLogGroup${suffix}`, {
        logGroupName: `/ecs/strata-pusher-${accountId}`,
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      const logDriver = ecs.LogDrivers.awsLogs({ streamPrefix: `strata-pusher-${accountId}`, logGroup });

      const readToken = new secretsmanager.Secret(this, `FleetReadToken${suffix}`, {
        secretName: `strata/guardian/awsread-token-${accountId}`,
        description: `Bearer token for the guardian-pusher-aws read API (account ${accountId})`,
        generateSecretString: { excludePunctuation: true, passwordLength: 48 },
      });
      readToken.grantRead(execRole);

      const taskRole = new iam.Role(this, `FleetTaskRole${suffix}`, {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess')],
      });
      taskRole.addToPolicy(
        new iam.PolicyStatement({
          actions: [
            'cloudwatch:GetMetricData',
            'cloudwatch:GetMetricStatistics',
            'cloudwatch:ListMetrics',
            'cloudwatch:DescribeAlarms',
            'cloudwatch:DescribeAlarmHistory',
            'cloudwatch:ListTagsForResource',
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
      taskRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['sts:AssumeRole'],
          resources: [`arn:aws:iam::${accountId}:role/${assumeRoleName}`],
        }),
      );

      const taskDef = new ecs.FargateTaskDefinition(this, `FleetTask${suffix}`, {
        family: `guardian-pusher-aws-${accountId}`,
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
        `--assume-role-name=${assumeRoleName} ` +
        '--cdk-binary=cdk ' +
        '--aws-state-dir=/var/lib/guardian/pusher-aws ' +
        '--bootstrap-stack-name=CDKToolkit ' +
        '--onboarding-ssm-prefix=/guardian/onboarding ' +
        '--cfn-execution-role=per-intent';

      taskDef.addContainer('guardian-pusher-aws', {
        image,
        logging: logDriver,
        entryPoint: ['/bin/sh', '-c'],
        command: [pusherScript],
        portMappings: [{ name: 'guardian-awsread', containerPort: 19090, protocol: ecs.Protocol.TCP }],
        environment: {
          GUARDIAN_PUSHER_NAME: pusherName,
          GUARDIAN_ACCOUNT: accountId,
          GUARDIAN_REGION: region,
          GUARDIAN_AWSREAD_ADDR: ':19090',
        },
        secrets: {
          GUARDIAN_MONOFS_TOKEN: ecs.Secret.fromSecretsManager(props.monofsToken),
          GUARDIAN_AWSREAD_TOKEN: ecs.Secret.fromSecretsManager(readToken),
        },
      });

      const service = new ecs.FargateService(this, `FleetService${suffix}`, {
        cluster: props.cluster,
        taskDefinition: taskDef,
        serviceName: `guardian-pusher-${accountId}`,
        desiredCount: 1,
        securityGroups: [props.monofsSg],
        vpcSubnets: props.vpcSubnets,
        assignPublicIp: false,
        serviceConnectConfiguration: {
          namespace: props.serviceConnectNamespace.namespaceName,
          services: [
            {
              portMappingName: 'guardian-awsread',
              // The Cloud Map discovery name must be unique per ECS service;
              // otherwise all fleet services collide on the port name.
              discoveryName: dnsName,
              dnsName,
              port: 19090,
            },
          ],
        },
        minHealthyPercent: 0,
        maxHealthyPercent: 100,
        circuitBreaker: { rollback: true },
      });
      service.node.addDependency(props.serviceConnectNamespace);
      if (props.monofsRouterSvc) {
        service.node.addDependency(props.monofsRouterSvc);
      }
      new SentinelDefaultAlarms(this, `SentinelDefaultAlarms${suffix}`, {
        pusherName,
        partition: (this.node.tryGetContext('sentinelPartition') as string | undefined)?.trim(),
        service,
      });
      new cdk.CfnOutput(this, `FleetPusher${index + 1}Name`, { value: pusherName });
      new cdk.CfnOutput(this, `FleetPusher${index + 1}ReadUrl`, { value: `http://${dnsName}:19090` });
      new cdk.CfnOutput(this, `FleetPusher${index + 1}ReadTokenSecretArn`, { value: readToken.secretArn });
      new cdk.CfnOutput(this, `FleetPusher${index + 1}TaskRoleArn`, { value: taskRole.roleArn });
    });

    // Keep the stack description in sync with the account list.
    this.templateOptions.description = `Strata — AWS pusher fleet (${accounts.length} target account(s))`;
  }
}
