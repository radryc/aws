import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { GuardianStack, outputLogicalId } from '../lib/guardian-constructs';

const ACCOUNT = '123456789012';
const REGION = 'us-east-1';

function makeStack(): cdk.App {
  return new cdk.App();
}

function newStack(app: cdk.App): GuardianStack {
  return new GuardianStack(app, 'guardian-aws-demo-demo-stack', {
    env: { account: ACCOUNT, region: REGION },
    partition: 'aws-demo',
    intent: 'demo-stack',
    stackName: 'guardian-aws-demo-demo-stack',
  });
}

describe('GuardianStack', () => {
  test('renders volume, object store, compute, load balancer and observability', () => {
    const app = makeStack();
    const stack = newStack(app);

    stack.addVolume('nginx-data', {
      properties: { accessMode: 'ReadWriteMany', size: '1Gi' },
      generated: { fileSystemName: 'aws-efs-123456789012-us-east-1-aws-demo-demo-stack-nginx-data' },
    });
    stack.addObjectStore('demo-bucket', {
      properties: { engine: 's3', region: REGION, versioning: true },
      generated: { bucketName: 'guardian-123456789012-us-east-1-aws-demo-demo-stack-demo-bucket' },
    });
    stack.addCompute('nginx', {
      properties: {
        image: 'public.ecr.aws/nginx/nginx:latest',
        env: { DEMO_API_KEY: 'placeholder', NGINX_PORT: '80' },
        ports: [{ name: 'http', containerPort: 80, protocol: 'TCP', servicePort: 80 }],
        configMounts: [{ config: 'nginx-page', path: '/usr/share/nginx/html', readOnly: true }],
        volumeMounts: [{ path: '/var/cache/nginx', volume: 'nginx-data' }],
        healthCheck: { test: ['CMD-SHELL', 'curl -f http://localhost/ || exit 1'], interval: '30s', timeout: '5s', retries: 3 },
        resources: { limits: { cpu: '256', memory: '512' }, requests: { cpu: '256', memory: '512' } },
      },
      generated: {
        cluster: ACCOUNT,
        serviceName: 'aws-svc-123456789012-us-east-1-aws-demo-demo-stack-nginx',
        taskFamily: 'aws-task-123456789012-us-east-1-aws-demo-demo-stack-nginx',
        logGroup: 'guardian/123456789012/us-east-1/aws-demo/demo-stack',
        configParams: { 'nginx-page': '/guardian/aws/ssm/123456789012/us/east/1/aws/demo/demo/stack/nginx/page' },
      },
    });
    stack.addLoadBalancer('nginx-edge', {
      properties: {
        targets: ['nginx'],
        listeners: [{ externalPort: 80, name: 'http', port: 80, protocol: 'http' }],
        serviceType: 'LoadBalancer',
      },
      generated: { lbName: 'guardian-demo-nginx-edge', tgNames: ['guardian-demo-nginx-tg0'] },
    });
    stack.addCompute('tracegen', {
      properties: {
        image: 'ghcr.io/open-telemetry/opentelemetry-collector-contrib/telemetrygen:v0.149.0',
        command: ['traces', '--otlp-insecure', '--service', 'aws-demo-tracegen'],
      },
      generated: {
        cluster: ACCOUNT,
        serviceName: 'aws-svc-123456789012-us-east-1-aws-demo-demo-stack-tracegen',
        taskFamily: 'aws-task-123456789012-us-east-1-aws-demo-demo-stack-tracegen',
        logGroup: 'guardian/123456789012/us-east-1/aws-demo/demo-stack',
        configParams: {},
      },
    });
    stack.addObservability('tracegen-otel', {
      properties: { exporters: ['awsemf', 'xray'], provider: 'otel', targets: ['tracegen'] },
      generated: {
        namespace: 'guardian/aws-demo/demo-stack',
        logGroup: 'guardian/123456789012/us-east-1/aws-demo/demo-stack/otel',
      },
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::EFS::FileSystem', 1);
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
    });
    template.resourceCountIs('AWS::ECS::Service', 2);
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', { Port: 80 });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({ Name: 'otel-collector', Essential: false }),
      ]),
    });
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: 'guardian/123456789012/us-east-1/aws-demo/demo-stack',
    });
    template.hasOutput('OutNginxService', {});
    template.hasOutput('OutNginxEdgeDnsName', {});
    template.hasOutput('OutDemoBucketBucket', {});
    template.hasOutput('OutNginxDataEfsId', {});
    template.hasOutput('OutTracegenOtelNamespace', {});
  });

  test('maps outputs to stable CloudFormation logical IDs', () => {
    expect(outputLogicalId('nginx-edge', 'dns_name')).toBe('OutNginxEdgeDnsName');
    expect(outputLogicalId('nginx', 'service')).toBe('OutNginxService');
    expect(outputLogicalId('tracegen-otel', 'tg_0_arn')).toBe('OutTracegenOtelTg0Arn');
  });

  test('rejects privileged compute and config-backed observability', () => {
    const stack = newStack(app());
    expect(() => stack.addCompute('bad', {
      properties: { image: 'nginx', privileged: true },
      generated: {},
    })).toThrow(/privileged/);

    const app2 = makeStack();
    const stack2 = newStack(app2);
    expect(() => stack2.addObservability('otel', {
      properties: { targets: [], config: 'some-config' },
      generated: {},
    })).toThrow(/Config-backed/);
  });
});

function app(): cdk.App {
  return makeStack();
}
