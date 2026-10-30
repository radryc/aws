import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { SentinelDefaultAlarms } from '../lib/sentinel-alarms';

describe('SentinelDefaultAlarms', () => {
  function makeStack() {
    const app = new cdk.App({ context: { sentinelPartition: 'payments' } });
    const stack = new cdk.Stack(app, 'Sentinel', {
      env: { account: '123456789012', region: 'eu-west-1' },
    });
    const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 1, natGateways: 0 });
    const cluster = new ecs.Cluster(stack, 'Cluster', { vpc });
    const task = new ecs.FargateTaskDefinition(stack, 'Task', { cpu: 256, memoryLimitMiB: 512 });
    task.addContainer('app', { image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/busybox:latest') });
    const service = new ecs.FargateService(stack, 'Service', {
      cluster,
      taskDefinition: task,
      desiredCount: 1,
    });
    const queue = new sqs.Queue(stack, 'Queue');
    const dlq = new sqs.Queue(stack, 'Dlq');
    new SentinelDefaultAlarms(stack, 'Alarms', {
      pusherName: 'aws-123456789012',
      partition: 'payments',
      service,
      queue,
      dlq,
    });
    return stack;
  }

  test('creates probe and pusher alarms with Sentinel tags', () => {
    const template = Template.fromStack(makeStack());
    template.resourceCountIs('AWS::CloudWatch::Alarm', 7);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: Match.stringLikeRegexp('probe-down'),
      ComparisonOperator: 'LessThanThreshold',
      TreatMissingData: 'breaching',
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: Match.stringLikeRegexp('dlq'),
      ComparisonOperator: 'GreaterThanThreshold',
    });

    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    const first = Object.values(alarms)[0] as any;
    const tags = JSON.stringify(first.Properties.Tags ?? []);
    expect(tags).toContain('sentinel.io/import');
    expect(tags).toContain('guardian.io/partition');
    expect(tags).toContain('payments');
    expect(tags).toContain('sentinel.io/rule-pack');
  });

  test('can be disabled', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Disabled');
    new SentinelDefaultAlarms(stack, 'Alarms', {
      enabled: false,
      pusherName: 'aws-1',
    });
    Template.fromStack(stack).resourceCountIs('AWS::CloudWatch::Alarm', 0);
  });
});
