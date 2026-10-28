import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AwsObservedPusherStack } from '../lib/aws-observed-pusher-stack';

const ACCOUNT = '123456789012';
const REGION = 'us-east-1';

jest.mock('aws-cdk-lib/aws-ecs', () => {
  const actual = jest.requireActual('aws-cdk-lib/aws-ecs');
  return {
    ...actual,
    ContainerImage: {
      ...actual.ContainerImage,
      fromRegistry: actual.ContainerImage.fromRegistry,
      fromAsset: jest.fn().mockImplementation((_dir: string, _props?: any) => {
        return actual.ContainerImage.fromRegistry('cdk-test/mock:latest');
      }),
    },
  };
});

function makeStack(id: string, props: Record<string, any> = {}): { stack: AwsObservedPusherStack } {
  const app = new cdk.App();
  const stack = new AwsObservedPusherStack(app, id, {
    env: { account: ACCOUNT, region: REGION },
    ...props,
  });
  return { stack };
}

describe('AwsObservedPusherStack', () => {
  test('is self-contained and runs the pusher in observed-only mode', () => {
    const { stack } = makeStack('ObservedPusherStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'guardian-observed-events-aws-123456789012',
    });
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        source: ['aws.cloudformation'],
        'detail-type': Match.arrayWith([
          'CloudFormation Stack Status Change',
          'CloudFormation Drift Detection Status Change',
        ]),
      },
    });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'guardian-observed-pusher-aws-123456789012',
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Command: Match.arrayWith([
            Match.stringLikeRegexp(
              '--observed-only.*--pusher-name=aws-123456789012.*--events-queue-url.*--onboarding-ssm-prefix=/guardian/onboarding',
            ),
          ]),
        }),
      ]),
    });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'cloudwatch-agent',
          Essential: false,
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'CW_CONFIG_CONTENT', Value: Match.stringLikeRegexp('guardian.pusher') }),
          ]),
        }),
      ]),
    });
    expect(JSON.stringify(template.toJSON())).toContain('ssm:GetParametersByPath');
    expect(JSON.stringify(template.toJSON())).toContain('xray:PutTraceSegments');
    template.hasOutput('PusherName', { Value: 'aws-123456789012' });
    template.hasOutput('AwsReadApiUrl', {});
    template.hasOutput('AwsReadTokenSecretArn', {});
    template.hasOutput('AwsObserveQueueUrl', {});
    template.hasOutput('OnboardingSsmPrefix', { Value: '/guardian/onboarding' });
    // No MonoFS coupling: the task must not receive a MonoFS token secret.
    const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
    for (const [, def] of Object.entries(taskDefs)) {
      const serialized = JSON.stringify(def);
      expect(serialized).not.toContain('GUARDIAN_MONOFS_TOKEN');
    }
  });

  test('honors pusherName and can disable the ALB', () => {
    const { stack } = makeStack('ObservedPusherNoAlbStack', {
      pusherName: 'aws-custom',
      exposeOnAlb: false,
      onboardingSsmPrefix: '/custom/onboarding/',
      cloudWatchAgent: false,
    });
    const template = Template.fromStack(stack);

    template.hasOutput('PusherName', { Value: 'aws-custom' });
    template.hasOutput('OnboardingSsmPrefix', { Value: '/custom/onboarding' });
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0);
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'guardian-observed-events-aws-custom',
    });
    const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
    const serialized = JSON.stringify(taskDefs);
    expect(serialized).not.toContain('cloudwatch-agent');
    expect(serialized).not.toContain('xray:PutTraceSegments');
  });
});
