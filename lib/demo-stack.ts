import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * Small demo stack for Guardian scan/import/deploy demos.
 *
 * Contains mappable resources (S3 -> ObjectStore, SSM -> Config,
 * Secret -> Secret) plus a tiny ECS Fargate service (Compute). Everything is
 * cheap: no NAT gateway, one 256/512 Fargate task, one-week log retention.
 */
export class DemoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new s3.Bucket(this, 'DemoBucket', {
      versioned: true,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new ssm.StringParameter(this, 'DemoParameter', {
      parameterName: '/strata/demo/greeting',
      stringValue: 'hello from the Strata demo stack',
    });

    new secretsmanager.Secret(this, 'DemoSecret', {
      secretName: 'strata/demo/api-key',
      generateSecretString: { excludePunctuation: true, passwordLength: 32 },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Tiny compute: nginx on Fargate. Public subnet + public IP avoids a NAT
    // gateway (keeps the demo stack essentially free at idle).
    const vpc = new ec2.Vpc(this, 'DemoVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
    });
    const cluster = new ecs.Cluster(this, 'DemoCluster', {
      vpc,
      clusterName: 'strata-demo',
    });
    const logGroup = new logs.LogGroup(this, 'DemoLogGroup', {
      logGroupName: '/ecs/strata-demo',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const taskDef = new ecs.FargateTaskDefinition(this, 'DemoTask', {
      family: 'strata-demo-nginx',
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    taskDef.addContainer('nginx', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/nginx/nginx:latest'),
      portMappings: [{ containerPort: 80 }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'strata-demo', logGroup }),
    });
    new ecs.FargateService(this, 'DemoSvc', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
    });
  }
}
