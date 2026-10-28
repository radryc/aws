import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { StrataStack } from '../lib/strata-stack';
import { AwsPusherStack } from '../lib/aws-pusher-stack';

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

function makePusherStack(id: string, context?: Record<string, any>): { app: cdk.App; stack: AwsPusherStack } {
  const app = new cdk.App({ context });
  const strata = new StrataStack(app, `${id}Strata`, {
    env: { account: ACCOUNT, region: REGION },
  });
  const stack = new AwsPusherStack(app, id, {
    env: { account: ACCOUNT, region: REGION },
    vpc: strata.vpc,
    cluster: strata.cluster,
    serviceConnectNamespace: strata.cloudMapNs,
    monofsSg: strata.monofsSg,
    vpcSubnets: strata.privateSubnets,
    monofsToken: strata.monofsToken,
    monofsRouterSvc: strata.monofsRouterSvc,
    alb: strata.alb,
    albListener: strata.albListener,
  });
  return { app, stack };
}

describe('AwsPusherStack', () => {
  test('provisions the EventBridge -> SQS observation pipeline', () => {
    const { stack } = makePusherStack('ObserveStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'guardian-aws-observe',
    });
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'guardian-aws-observe-dlq',
    });
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        source: ['aws.cloudformation'],
        'detail-type': [
          'CloudFormation Stack Status Change',
          'CloudFormation Drift Detection Status Change',
        ],
      },
    });
    template.hasOutput('AwsObserveQueueUrl', {});
  });

  test('pusher task receives the observe queue URL', () => {
    const { stack } = makePusherStack('ObserveEnvStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'GUARDIAN_AWS_EVENTS_QUEUE_URL' }),
          ]),
        }),
      ]),
    });
  });

  test('observe pipeline can be disabled with context', () => {
    const { stack } = makePusherStack('ObserveDisabledStack', { deployAwsObserve: false });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::SQS::Queue', 0);
    template.resourceCountIs('AWS::Events::Rule', 0);
  });

  test('pusher name context is honored', () => {
    const { stack } = makePusherStack('PusherNameStack', { pusherName: 'aws-custom' });
    const template = Template.fromStack(stack);

    template.hasOutput('PusherName', { Value: 'aws-custom' });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'GUARDIAN_PUSHER_NAME', Value: 'aws-custom' }),
          ]),
        }),
      ]),
    });
  });
});
