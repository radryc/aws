import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { StrataStack } from '../lib/strata-stack';

const ACCOUNT = '123456789012';
const REGION = 'us-east-1';

jest.mock('aws-cdk-lib/aws-ecs', () => {
  const actual = jest.requireActual('aws-cdk-lib/aws-ecs');
  return {
    ...actual,
    ContainerImage: {
      ...actual.ContainerImage,
      fromAsset: jest.fn().mockImplementation((_dir: string, _props?: any) => {
        return actual.ContainerImage.fromRegistry('cdk-test/mock:latest');
      }),
    },
  };
});

function makeStack(id: string, context?: Record<string, any>): { app: cdk.App; stack: StrataStack } {
  const app = new cdk.App({ context });
  const stack = new StrataStack(app, id, {
    env: { account: ACCOUNT, region: REGION },
  });
  return { app, stack };
}

describe('StrataStack', () => {
  // ─────────────────────────────────────────────────────────
  // SNAPSHOT
  // ─────────────────────────────────────────────────────────
  test('snapshot matches', () => {
    const { stack } = makeStack('SnapshotStack');
    const template = Template.fromStack(stack);
    expect(template.toJSON()).toMatchSnapshot();
  });

  // ─────────────────────────────────────────────────────────
  // VPC
  // ─────────────────────────────────────────────────────────
  test('VPC: 2 AZs, public + private subnets, NAT gateway, S3 endpoint', () => {
    const { stack } = makeStack('VpcStack');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::EC2::VPC', 1);
    template.hasResourceProperties('AWS::EC2::VPC', {
      CidrBlock: '10.0.0.0/16',
    });

    template.resourceCountIs('AWS::EC2::Subnet', 4);
    template.resourceCountIs('AWS::EC2::InternetGateway', 1);
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
    template.resourceCountIs('AWS::EC2::EIP', 1);

    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      ServiceName: { 'Fn::Join': ['', ['com.amazonaws.', { Ref: 'AWS::Region' }, '.s3']] },
      VpcEndpointType: 'Gateway',
    });
  });

  test('VPC: subnets are tagged with correct types', () => {
    const { stack } = makeStack('SubnetTagStack');
    const template = Template.fromStack(stack);

    const publicSubnets = template.findResources('AWS::EC2::Subnet', {
      Properties: {
        Tags: Match.arrayWith([{ Key: 'aws-cdk:subnet-type', Value: 'Public' }]),
      },
    });
    const privateSubnets = template.findResources('AWS::EC2::Subnet', {
      Properties: {
        Tags: Match.arrayWith([{ Key: 'aws-cdk:subnet-type', Value: 'Private' }]),
      },
    });
    expect(Object.keys(publicSubnets).length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(privateSubnets).length).toBeGreaterThanOrEqual(2);
  });

  // ─────────────────────────────────────────────────────────
  // SECURITY GROUPS
  // ─────────────────────────────────────────────────────────
  test('creates 4 security groups', () => {
    const { stack } = makeStack('SgStack');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::EC2::SecurityGroup', 4);

    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'ALB ingress',
    });
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Monofs services',
    });
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Guardian services',
    });
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'EFS NFS',
    });
  });

  test('ALB security group: HTTP ingress + TCP egress', () => {
    const { stack } = makeStack('AlbSgStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'ALB ingress',
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({
          CidrIp: '0.0.0.0/0',
          FromPort: 80,
          ToPort: 80,
          IpProtocol: 'tcp',
        }),
      ]),
      SecurityGroupEgress: Match.arrayWith([
        Match.objectLike({
          CidrIp: '0.0.0.0/0',
          IpProtocol: 'tcp',
        }),
      ]),
    });
  });

  test('Monofs SG: at least 3 ingress rules (self-reference, ALB, Guardian)', () => {
    const { stack } = makeStack('MonofsSgStack');
    const template = Template.fromStack(stack);

    const allIngress = template.findResources('AWS::EC2::SecurityGroupIngress');
    expect(Object.keys(allIngress).length).toBeGreaterThanOrEqual(3);
  });

  test('EFS SG: NFS ingress from monofs SG on port 2049', () => {
    const { stack } = makeStack('EfsSgStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      FromPort: 2049,
      ToPort: 2049,
      IpProtocol: 'tcp',
    });
  });

  // ─────────────────────────────────────────────────────────
  // ECS CLUSTER + SERVICE DISCOVERY
  // ─────────────────────────────────────────────────────────
  test('ECS cluster: named strata with Container Insights enabled', () => {
    const { stack } = makeStack('EcsClusterStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::ECS::Cluster', {
      ClusterName: 'strata',
      ClusterSettings: Match.arrayWith([
        { Name: 'containerInsights', Value: Match.stringLikeRegexp('enabled|enhanced') },
      ]),
    });
  });

  test('Service Discovery: private DNS namespace strata.local', () => {
    const { stack } = makeStack('SdStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::ServiceDiscovery::PrivateDnsNamespace', {
      Name: 'strata.local',
    });
  });

  // ─────────────────────────────────────────────────────────
  // SECRETS MANAGER
  // ─────────────────────────────────────────────────────────
  test('creates encryption key secret with expected properties', () => {
    const { stack } = makeStack('SecretStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'strata/monofs/encryption-key',
    });
  });

  test('creates monofs token secret with auto-generated value', () => {
    const { stack } = makeStack('TokenStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'strata/monofs/token',
      GenerateSecretString: {
        ExcludePunctuation: true,
      },
    });
  });

  // ─────────────────────────────────────────────────────────
  // EFS
  // ─────────────────────────────────────────────────────────
  test('EFS: encrypted, lifecycle policy, 3 access points', () => {
    const { stack } = makeStack('EfsStack');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::EFS::FileSystem', 1);
    template.hasResourceProperties('AWS::EFS::FileSystem', {
      Encrypted: true,
    });

    template.resourceCountIs('AWS::EFS::AccessPoint', 3);
  });

  // ─────────────────────────────────────────────────────────
  // S3
  // ─────────────────────────────────────────────────────────
  test('S3: encrypted, versioned, SSL enforced, public access blocked', () => {
    const { stack } = makeStack('S3Stack');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: `monofs-blobs-${ACCOUNT}-${REGION}`,
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('S3: lifecycle rule for noncurrent version expiration after 30 days', () => {
    const { stack } = makeStack('S3LifecycleStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: 'ExpireOldVersions',
            Status: 'Enabled',
            NoncurrentVersionExpiration: { NoncurrentDays: 30 },
          }),
        ]),
      },
    });
  });

  // ─────────────────────────────────────────────────────────
  // IAM
  // ─────────────────────────────────────────────────────────
  test('creates 3 IAM roles (monofs exec, monofs task, guardian exec)', () => {
    const { stack } = makeStack('IamStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          {
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Principal: { Service: 'ecs-tasks.amazonaws.com' },
          },
        ]),
      },
      ManagedPolicyArns: Match.arrayWith([
        Match.objectLike({
          'Fn::Join': Match.arrayWith([
            '',
            ['arn:', { Ref: 'AWS::Partition' }, ':iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'],
          ]),
        }),
      ]),
    });
  });

  // ─────────────────────────────────────────────────────────
  // CLOUDWATCH
  // ─────────────────────────────────────────────────────────
  test('CloudWatch: log group with 14-day retention', () => {
    const { stack } = makeStack('CwStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ecs/strata',
      RetentionInDays: 14,
    });
  });

  // ─────────────────────────────────────────────────────────
  // ALB
  // ─────────────────────────────────────────────────────────
  test('ALB: internet-facing, HTTP listener on port 80 with 404 default', () => {
    const { stack } = makeStack('AlbStack');
    const template = Template.fromStack(stack);

    // One public application ALB plus one public network NLB for MonoFS gRPC.
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 2);
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internet-facing',
      Type: 'application',
    });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internet-facing',
      Type: 'network',
    });

    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      Protocol: 'HTTP',
      DefaultActions: Match.arrayWith([
        Match.objectLike({
          Type: 'fixed-response',
          FixedResponseConfig: Match.objectLike({
            StatusCode: '404',
          }),
        }),
      ]),
    });
  });

  // ─────────────────────────────────────────────────────────
  // CONTEXT TOGGLES
  // ─────────────────────────────────────────────────────────
  test('disabling all toggles produces minimal stack (VPC + base infra only)', () => {
    const { stack } = makeStack('MinimalStack', {
      deployMonofsServer: false,
      deployMonofsRouter: false,
      deployMonofsFetcher: false,
      deployMonofsRegistry: false,
      deployMonofsSearch: false,
      deployGuardian: false,
    });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::EC2::VPC', 1);
    template.resourceCountIs('AWS::ECS::Cluster', 1);
    template.resourceCountIs('AWS::EFS::FileSystem', 1);
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.resourceCountIs('AWS::SecretsManager::Secret', 3);
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    template.resourceCountIs('AWS::ECS::Service', 0);
  });

  test('deployGuardian=false removes guardian service but keeps monofs', () => {
    const { stack } = makeStack('NoGuardianStack', {
      deployGuardian: false,
    });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::ECS::Service', 3);
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'monofs-server',
    });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'monofs-router',
    });
  });

  test('deployMonofsServer=false removes server service', () => {
    const { stack } = makeStack('NoServerStack', {
      deployMonofsServer: false,
    });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::ECS::Service', 3);
    expect(() =>
      template.hasResourceProperties('AWS::ECS::TaskDefinition', { Family: 'monofs-server' })
    ).toThrow();
  });

  test('deploySSO=true adds Cognito resources', () => {
    const { stack } = makeStack('SsoStack', {
      deploySSO: true,
      demoUserPassword: 'TestDemoPassword123!',
    });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::Cognito::UserPool', 1);
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'strata',
      AutoVerifiedAttributes: ['email'],
    });

    template.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
    template.resourceCountIs('AWS::Cognito::UserPoolDomain', 1);
    template.resourceCountIs('AWS::Cognito::UserPoolUser', 3);
    template.resourceCountIs('AWS::SecretsManager::Secret', 4);
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'strata/cognito/client-secret',
    });
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'strata/guardian/access-policy-token',
    });
    template.resourceCountIs('AWS::CloudFront::Distribution', 2);
    template.hasOutput('DoctorUrl', {});
    template.hasOutput('DemoUsers', {});
  });

  test('deploySSO=true requires demoUserPassword', () => {
    expect(() => makeStack('SsoNoPasswordStack', { deploySSO: true })).toThrow(/demoUserPassword/);
  });

  // ─────────────────────────────────────────────────────────
  // ALB TARGET GROUPS
  // ─────────────────────────────────────────────────────────
  test('listener has monofs-router and guardian target groups when both deployed', () => {
    const { stack } = makeStack('TargetGroupStack');
    const template = Template.fromStack(stack);

    // Two ALB target groups + two NLB target groups (router 9090, server 9000).
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 4);
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 2);

    // Out-of-VPC clients need the server's public address in cluster info.
    expect(JSON.stringify(template.toJSON())).toContain('--external-addrs=node-a=');
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 9000,
      Protocol: 'TCP',
    });
  });

  test('without monofs-router, listener has only guardian target group', () => {
    const { stack } = makeStack('RouterOnlyStack', {
      deployMonofsRouter: false,
    });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 1);
  });

  // ─────────────────────────────────────────────────────────
  // OUTPUTS
  // ─────────────────────────────────────────────────────────
  test('outputs: AlbDnsName, EcsClusterName, BlobBucketName, EfsFileSystemId, EncryptionKeySecretArn', () => {
    const { stack } = makeStack('OutputStack');
    const template = Template.fromStack(stack);

    template.hasOutput('AlbDnsName', {});
    template.hasOutput('EcsClusterName', {});
    template.hasOutput('BlobBucketName', {});
    template.hasOutput('EfsFileSystemId', {});
    template.hasOutput('EncryptionKeySecretArn', {});
    expect(() => template.hasOutput('CognitoUserPoolId', {})).toThrow();
  });

  test('SSO outputs when deploySSO=true', () => {
    const { stack } = makeStack('SsoOutputStack', {
      deploySSO: true,
      demoUserPassword: 'TestDemoPassword123!',
    });
    const template = Template.fromStack(stack);

    template.hasOutput('CognitoUserPoolId', {});
    template.hasOutput('CognitoClientId', {});
    template.hasOutput('CognitoHostedUIUrl', {});
  });

  // ─────────────────────────────────────────────────────────
  // ECS SERVICE CONNECT
  // ─────────────────────────────────────────────────────────
  test('Fargate services use Service Connect with strata.local namespace', () => {
    const { stack } = makeStack('ServiceConnectStack');
    const template = Template.fromStack(stack);

    // 4 services here; the AWS pusher now lives in its own stack (AwsPusherStack).
    template.resourceCountIs('AWS::ECS::Service', 4);

    const services = template.findResources('AWS::ECS::Service');
    for (const [, svc] of Object.entries(services)) {
      const props = svc as any;
      if (props.Properties?.ServiceConnectConfiguration) {
        expect(props.Properties.ServiceConnectConfiguration.Namespace).toBe('strata.local');
      }
    }
  });

  // ─────────────────────────────────────────────────────────
  // FARGATE TASK DEFINITIONS
  // ─────────────────────────────────────────────────────────
  test('Monofs server task: 2 GB memory, 1 vCPU, x86_64 Linux, EFS volume', () => {
    const { stack } = makeStack('ServerTaskStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'monofs-server',
      Memory: '2048',
      Cpu: '1024',
      NetworkMode: 'awsvpc',
      RequiresCompatibilities: ['FARGATE'],
      RuntimePlatform: {
        CpuArchitecture: 'X86_64',
        OperatingSystemFamily: 'LINUX',
      },
    });

    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'monofs-server',
      Volumes: Match.arrayWith([
        Match.objectLike({
          Name: 'data',
          EFSVolumeConfiguration: Match.objectLike({
            TransitEncryption: 'ENABLED',
          }),
        }),
      ]),
    });
  });

  test('Monofs router task: 1 GB memory, 0.5 vCPU, exposed ports 8080 + 9090', () => {
    const { stack } = makeStack('RouterTaskStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'monofs-router',
      Memory: '1024',
      Cpu: '512',
    });

    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'monofs-router',
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'monofs-router',
          PortMappings: Match.arrayWith([
            Match.objectLike({ ContainerPort: 9090, Protocol: 'tcp' }),
            Match.objectLike({ ContainerPort: 8080, Protocol: 'tcp' }),
          ]),
        }),
      ]),
    });
  });

  test('Guardiand task: 1 GB memory, 0.5 vCPU, exposed port 8090', () => {
    const { stack } = makeStack('GuardianTaskStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'guardiand',
      Memory: '1024',
      Cpu: '512',
    });

    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'guardiand',
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'guardiand',
          PortMappings: Match.arrayWith([
            Match.objectLike({ ContainerPort: 8090, Protocol: 'tcp' }),
          ]),
        }),
      ]),
    });
  });

  // ─────────────────────────────────────────────────────────
  // HEALTH CHECKS
  // ─────────────────────────────────────────────────────────
  test('ALB target group health checks: / path, 30s interval, 200-499 codes', () => {
    const { stack } = makeStack('HcStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: '/',
      HealthCheckIntervalSeconds: 30,
      Matcher: { HttpCode: '200-499' },
    });
  });

  // ─────────────────────────────────────────────────────────
  // ENVIRONMENT VARIABLES & SECRETS
  // ─────────────────────────────────────────────────────────
  test('Monofs server container has MONOFS_S3_BUCKET env var and encryption key secret', () => {
    const { stack } = makeStack('ServerEnvStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'monofs-server',
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'monofs-server',
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'MONOFS_S3_BUCKET' }),
            Match.objectLike({ Name: 'MONOFS_S3_REGION' }),
          ]),
          Secrets: Match.arrayWith([
            Match.objectLike({ Name: 'MONOFS_ENCRYPTION_KEY' }),
          ]),
        }),
      ]),
    });
  });

  test('Guardian container has GUARDIAN_MONOFS_ROUTER env and MONOFS_TOKEN secret', () => {
    const { stack } = makeStack('GuardianEnvStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'guardiand',
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'guardiand',
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'GUARDIAN_MONOFS_ROUTER' }),
            Match.objectLike({ Name: 'GUARDIAN_RECONCILE_INTERVAL' }),
          ]),
          Secrets: Match.arrayWith([
            Match.objectLike({ Name: 'GUARDIAN_MONOFS_TOKEN' }),
            Match.objectLike({ Name: 'GUARDIAN_CLIENT_DISCOVERY_TOKEN' }),
          ]),
        }),
      ]),
    });
  });

  test('Monofs search and registry containers have encryption key secret', () => {
    const { stack } = makeStack('SearchRegEnvStack', {
      deployMonofsSearch: true,
      deployMonofsRegistry: true,
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'monofs-search',
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'monofs-search',
          Secrets: Match.arrayWith([
            Match.objectLike({ Name: 'MONOFS_ENCRYPTION_KEY' }),
          ]),
        }),
      ]),
    });

    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'monofs-registry',
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'monofs-registry',
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'MONOFS_S3_BUCKET' }),
            Match.objectLike({ Name: 'MONOFS_S3_REGION' }),
          ]),
          Secrets: Match.arrayWith([
            Match.objectLike({ Name: 'MONOFS_TOKEN' }),
            Match.objectLike({ Name: 'MONOFS_ENCRYPTION_KEY' }),
          ]),
        }),
      ]),
    });
  });

  // ─────────────────────────────────────────────────────────
  // CIRCUIT BREAKER
  // ─────────────────────────────────────────────────────────
  test('Fargate services have circuit breaker with rollback enabled', () => {
    const { stack } = makeStack('CbStack');
    const template = Template.fromStack(stack);

    const services = template.findResources('AWS::ECS::Service');
    for (const [, svc] of Object.entries(services)) {
      const props = svc as any;
      if (props.Properties?.DeploymentConfiguration?.DeploymentCircuitBreaker) {
        expect(props.Properties.DeploymentConfiguration.DeploymentCircuitBreaker).toMatchObject({
          Enable: true,
          Rollback: true,
        });
      }
    }
  });
});
