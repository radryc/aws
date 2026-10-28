import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { GuardianObserve } from '../lib/guardian-observe';

const ACCOUNT = '123456789012';
const REGION = 'eu-west-1';

function makeStack(): cdk.Stack {
  const app = new cdk.App();
  return new cdk.Stack(app, 'CustomerAppStack', {
    env: { account: ACCOUNT, region: REGION },
  });
}

function addService(stack: cdk.Stack): ecs.FargateService {
  const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 2, natGateways: 0 });
  const cluster = new ecs.Cluster(stack, 'Cluster', { vpc });
  const taskDefinition = new ecs.FargateTaskDefinition(stack, 'Task');
  taskDefinition.addContainer('app', {
    image: ecs.ContainerImage.fromRegistry('public.ecr.aws/nginx/nginx:latest'),
    portMappings: [{ containerPort: 8080 }],
  });
  return new ecs.FargateService(stack, 'Service', { cluster, taskDefinition });
}

describe('GuardianObserve', () => {
  test('publishes the SSM descriptor and adds the CloudWatch agent sidecar', () => {
    const stack = makeStack();
    const service = addService(stack);
    new GuardianObserve(stack, 'Guardian', {
      partition: 'customer-acme-prod-2',
      intent: 'app',
      repo: {
        url: 'https://github.com/acme/app.git',
        branch: 'main',
        selector: 'CustomerAppStack',
      },
      publish: { mode: 'repo', repo: 'guardian-onboarding-acme' },
      probes: [{ name: 'health', type: 'http', url: 'https://api.example.com', path: '/healthz' }],
      telemetry: { logGroup: '/aws/ecs/customer-app' },
      targets: [service],
    });

    const template = Template.fromStack(stack);
    const parameters = template.findResources('AWS::SSM::Parameter');
    const parameter = Object.values(parameters)[0] as any;
    expect(parameter.Properties.Name).toBe('/guardian/onboarding/CustomerAppStack');
    const serialized = JSON.stringify(parameter);
    expect(serialized).toContain('customer-acme-prod-2');
    expect(serialized).toContain('https://github.com/acme/app.git');
    expect(serialized).toContain('/healthz');

    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({ Name: 'app' }),
        Match.objectLike({
          Name: 'cloudwatch-agent',
          Essential: false,
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'CW_CONFIG_CONTENT', Value: Match.stringLikeRegexp('guardian.partition') }),
          ]),
        }),
      ]),
    });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'app',
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'OTEL_EXPORTER_OTLP_ENDPOINT', Value: 'http://localhost:4317' }),
          ]),
        }),
      ]),
    });
    expect(JSON.stringify(template.toJSON())).toContain('xray:PutTraceSegments');
    const outputs = template.toJSON().Outputs ?? {};
    const outputValues = JSON.stringify(outputs);
    expect(outputValues).toContain('http://localhost:4317');
    expect(outputValues).toContain('GuardianOnboardingParameter');
  });

  test('works without compute targets and does not duplicate the agent', () => {
    const stack = makeStack();
    new GuardianObserve(stack, 'Guardian', {
      partition: 'customer-acme-prod-2',
      targets: [],
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::SSM::Parameter', 1);
    expect(() => {
      new GuardianObserve(stack, 'GuardianAgain', {
        partition: 'customer-acme-prod-2',
      });
    }).not.toThrow();
  });

  test('rejects an empty partition', () => {
    const stack = makeStack();
    expect(() => new GuardianObserve(stack, 'Guardian', { partition: '' })).toThrow(/partition/);
  });
});
