import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AssetCall } from '../templates/aws/v1/_shared/helpers';
import { networkVpc } from '../templates/aws/v1/network.vpc/construct';
import { networkDefault } from '../templates/aws/v1/network.default/construct';
import { volumeEfs } from '../templates/aws/v1/volume.efs/construct';
import { objectStoreS3 } from '../templates/aws/v1/objectstore.s3/construct';
import { computeFargate } from '../templates/aws/v1/compute.fargate/construct';
import { loadBalancerAlb } from '../templates/aws/v1/loadbalancer.alb/construct';
import { loadBalancerNlb } from '../templates/aws/v1/loadbalancer.nlb/construct';
import { databaseAuroraPostgres } from '../templates/aws/v1/database.aurora-postgres/construct';
import { databaseAuroraMysql } from '../templates/aws/v1/database.aurora-mysql/construct';
import { observabilityOtelSidecar } from '../templates/aws/v1/observability.otel-sidecar/construct';
import { cfnResource } from '../templates/aws/v1/fallback.cfn-resource/construct';

const ACCOUNT = '123456789012';
const REGION = 'us-east-1';

function newStack(app: cdk.App, id = 'guardian-test-stack'): cdk.Stack {
  return new cdk.Stack(app, id, { env: { account: ACCOUNT, region: REGION } });
}

function call(properties: Record<string, any>, generated: Record<string, any> = {}, refs: Record<string, any> = {}): AssetCall {
  return { properties, generated, refs, partition: 'demo', intent: 'test' };
}

describe('network templates', () => {
  test('networkVpc creates the VPC and exports outputs', () => {
    const app = new cdk.App();
    const stack = newStack(app);
    networkVpc(stack, 'main', call({ cidr: '10.9.0.0/16' }, { vpcName: 'demo-vpc' }));
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::EC2::VPC', { CidrBlock: '10.9.0.0/16' });
    template.hasOutput('OutMainVpcId', {});
    template.hasOutput('OutMainCidr', { Value: '10.9.0.0/16' });
    template.hasOutput('OutMainName', { Value: 'demo-vpc' });
  });

  test('networkDefault creates the shared DefaultVpc construct', () => {
    const app = new cdk.App();
    const stack = newStack(app);
    const handle = networkDefault(stack);
    expect(handle.vpc).toBeDefined();
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::EC2::VPC', 1);
  });
});

describe('volume template', () => {
  test('volumeEfs mounts an encrypted filesystem in the network subnets', () => {
    const app = new cdk.App();
    const stack = newStack(app);
    const network = networkDefault(stack);
    volumeEfs(stack, 'data', call({ size: '1Gi' }, { fileSystemName: 'demo-efs' }, { network }));
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::EFS::FileSystem', { Encrypted: true });
    template.resourceCountIs('AWS::EFS::MountTarget', 2);
    template.hasOutput('OutDataEfsId', {});
    template.hasOutput('OutDataType', { Value: 'efs' });
  });

  test('volumeEfs rejects a missing network ref', () => {
    const app = new cdk.App();
    const stack = newStack(app);
    expect(() => volumeEfs(stack, 'data', call({}))).toThrow(/refs.network is required/);
  });
});

describe('object store template', () => {
  test('objectStoreS3 creates a versioned bucket with outputs', () => {
    const app = new cdk.App();
    const stack = newStack(app);
    objectStoreS3(stack, 'bucket', call({ versioning: true }, { bucketName: 'demo-bucket' }));
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::S3::Bucket', { VersioningConfiguration: { Status: 'Enabled' } });
    template.hasOutput('OutBucketBucket', { Value: 'demo-bucket' });
    template.hasOutput('OutBucketType', { Value: 's3' });
  });
});

describe('compute template', () => {
  test('computeFargate creates a Fargate service with environment and health check', () => {
    const app = new cdk.App();
    const stack = newStack(app);
    const network = networkDefault(stack);
    computeFargate(stack, 'api', call(
      {
        image: 'public.ecr.aws/nginx/nginx:latest',
        replicas: 2,
        ports: [{ name: 'http', containerPort: 8080, protocol: 'TCP' }],
        env: { LOG_LEVEL: 'debug' },
        healthCheck: { test: ['CMD-SHELL', 'curl -f http://localhost/ || exit 1'], interval: '30s' },
        resources: { limits: { cpu: '512', memory: '1024' } },
      },
      { cluster: 'demo', serviceName: 'demo-svc', taskFamily: 'demo-task', logGroup: '/demo/logs', configParams: {} },
      { network },
    ));
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::ECS::Service', { DesiredCount: 2 });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '512',
      Memory: '1024',
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'api',
          Environment: Match.arrayWith([
            { Name: 'LOG_LEVEL', Value: 'debug' },
            Match.objectLike({ Name: 'OTEL_RESOURCE_ATTRIBUTES' }),
          ]),
        }),
      ]),
    });
    template.hasOutput('OutApiService', {});
    template.hasOutput('OutApiLaunchType', { Value: 'FARGATE' });
  });

  test('computeFargate shares a cluster handle and mounts volumes', () => {
    const app = new cdk.App();
    const stack = newStack(app);
    const network = networkDefault(stack);
    const data = volumeEfs(stack, 'data', call({}, { fileSystemName: 'demo-efs' }, { network }));
    const first = computeFargate(stack, 'api-a', call(
      { image: 'nginx', volumeMounts: [{ path: '/data', volume: 'data' }] },
      { cluster: 'shared', serviceName: 'svc-a', taskFamily: 'task-a', logGroup: '/demo/logs', configParams: {} },
      { network, volumes: { data } },
    ));
    const second = computeFargate(stack, 'api-b', call(
      { image: 'nginx' },
      { cluster: 'shared', serviceName: 'svc-b', taskFamily: 'task-b', logGroup: '/demo/logs', configParams: {} },
      { network, cluster: first.cluster },
    ));
    expect(second.cluster).toBe(first.cluster);
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::ECS::Cluster', 1);
    template.resourceCountIs('AWS::ECS::Service', 2);
  });

  test('computeFargate rejects missing volumes and privileged mode', () => {
    const app = new cdk.App();
    const stack = newStack(app);
    const network = networkDefault(stack);
    expect(() => computeFargate(stack, 'api', call(
      { image: 'nginx', volumeMounts: [{ path: '/data', volume: 'missing' }] },
      { cluster: 'demo', serviceName: 'svc', taskFamily: 'task', logGroup: '/demo/logs', configParams: {} },
      { network },
    ))).toThrow(/volume missing was not generated before it/);
    expect(() => computeFargate(stack, 'api2', call(
      { image: 'nginx', privileged: true },
      { cluster: 'demo', serviceName: 'svc2', taskFamily: 'task2', logGroup: '/demo/logs', configParams: {} },
      { network },
    ))).toThrow(/privileged/);
  });
});

describe('load balancer templates', () => {
  test('loadBalancerAlb creates an ALB with a target group per listener', () => {
    const app = new cdk.App();
    const stack = newStack(app);
    const network = networkDefault(stack);
    const api = computeFargate(stack, 'api', call(
      { image: 'nginx', ports: [{ name: 'http', containerPort: 80 }] },
      { cluster: 'demo', serviceName: 'svc', taskFamily: 'task', logGroup: '/demo/logs', configParams: {} },
      { network },
    ));
    loadBalancerAlb(stack, 'edge', call(
      { targets: ['api'], listeners: [{ port: 80, protocol: 'http' }] },
      { lbName: 'demo-lb', tgNames: ['demo-tg0'] },
      { network, targets: [api] },
    ));
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', { Type: 'application' });
    template.hasOutput('OutEdgeTg0Arn', {});
    template.hasOutput('OutEdgeDnsName', {});
  });

  test('loadBalancerNlb creates a network load balancer', () => {
    const app = new cdk.App();
    const stack = newStack(app);
    const network = networkDefault(stack);
    const api = computeFargate(stack, 'api', call(
      { image: 'nginx', ports: [{ name: 'tcp', containerPort: 9092 }] },
      { cluster: 'demo', serviceName: 'svc', taskFamily: 'task', logGroup: '/demo/logs', configParams: {} },
      { network },
    ));
    loadBalancerNlb(stack, 'edge', call(
      { targets: ['api'], listeners: [{ port: 9092, protocol: 'tcp' }] },
      { lbName: 'demo-lb', tgNames: ['demo-tg0'] },
      { network, targets: [api] },
    ));
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', { Type: 'network' });
    template.hasOutput('OutEdgeTg0Arn', {});
  });
});

describe('database templates', () => {
  test('databaseAuroraPostgres selects the postgres engine', () => {
    const app = new cdk.App();
    const stack = newStack(app);
    const network = networkDefault(stack);
    databaseAuroraPostgres(stack, 'db', call({ engine: 'aurora-postgresql' }, { clusterName: 'demo-db' }, { network }));
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::RDS::DBCluster', { Engine: 'aurora-postgresql' });
    template.hasOutput('OutDbEngine', { Value: 'aurora-postgresql' });
    template.hasOutput('OutDbSecretArn', {});
  });

  test('databaseAuroraMysql selects the mysql engine', () => {
    const app = new cdk.App();
    const stack = newStack(app);
    const network = networkDefault(stack);
    databaseAuroraMysql(stack, 'db', call({}, { clusterName: 'demo-db' }, { network }));
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::RDS::DBCluster', { Engine: 'aurora-mysql' });
    template.hasOutput('OutDbEngine', { Value: 'aurora-mysql' });
  });
});

describe('observability template', () => {
  test('observabilityOtelSidecar injects the collector into target tasks', () => {
    const app = new cdk.App();
    const stack = newStack(app);
    const network = networkDefault(stack);
    const api = computeFargate(stack, 'api', call(
      { image: 'nginx', ports: [{ name: 'http', containerPort: 80 }] },
      { cluster: 'demo', serviceName: 'svc', taskFamily: 'task', logGroup: '/demo/logs', configParams: {} },
      { network },
    ));
    observabilityOtelSidecar(stack, 'otel', call(
      { targets: ['api'], exporters: ['awsemf', 'xray'], provider: 'otel' },
      { namespace: 'guardian/demo/test', logGroup: '/demo/otel' },
      { targets: [api] },
    ));
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({ Name: 'otel-collector', Essential: false }),
      ]),
    });
    template.hasOutput('OutOtelEndpoint', { Value: 'http://localhost:4317' });
    template.hasOutput('OutOtelNamespace', { Value: 'guardian/demo/test' });
  });
});

describe('fallback template', () => {
  test('cfnResource renders a raw CloudFormation resource with outputs', () => {
    const app = new cdk.App();
    const stack = newStack(app);
    cfnResource(stack, 'queue', call({
      cfnType: 'AWS::SQS::Queue',
      properties: { QueueName: 'guardian-queue' },
      outputs: { queueName: 'guardian-queue' },
    }));
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'guardian-queue' });
    template.hasOutput('OutQueueQueueName', { Value: 'guardian-queue' });
  });

  test('cfnResource rejects a missing cfnType', () => {
    const app = new cdk.App();
    const stack = newStack(app);
    expect(() => cfnResource(stack, 'bad', call({}))).toThrow(/cfnType is required/);
  });
});
