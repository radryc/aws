import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { AwsPusherFleetStack } from '../lib/aws-pusher-fleet-stack';

function fleetStack(accounts: string[]): cdk.Stack {
  const app = new cdk.App();
  const env = { account: '111111111111', region: 'us-east-1' };
  const base = new cdk.Stack(app, 'Base', { env });
  const vpc = new ec2.Vpc(base, 'Vpc', { maxAzs: 2, natGateways: 1 });
  const cluster = new ecs.Cluster(base, 'Cluster', { vpc });
  const namespace = new servicediscovery.PrivateDnsNamespace(base, 'Namespace', {
    name: 'strata.local',
    vpc,
  });
  const monofsSg = new ec2.SecurityGroup(base, 'MonofsSg', { vpc });
  const token = new secretsmanager.Secret(base, 'MonofsToken');
  return new AwsPusherFleetStack(app, 'AwsPusherFleetStack', {
    env,
    vpc,
    cluster,
    serviceConnectNamespace: namespace,
    monofsSg,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    monofsToken: token,
    targetAccounts: accounts,
  });
}

describe('AwsPusherFleetStack', () => {
  test('creates one pusher service per target account', () => {
    const stack = fleetStack(['222222222222', '333333333333']);
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::ECS::Service', 2);
    template.resourceCountIs('AWS::ECS::TaskDefinition', 2);
    template.hasOutput('FleetPusher1Name', { Value: 'aws-222222222222' });
    template.hasOutput('FleetPusher1ReadUrl', { Value: 'http://guardian-awsread-1:19090' });
    template.hasOutput('FleetPusher2Name', { Value: 'aws-333333333333' });
    template.hasOutput('FleetPusher2ReadUrl', { Value: 'http://guardian-awsread-2:19090' });
  });

  test('task roles can assume the deploy role in the target account', () => {
    const stack = fleetStack(['222222222222']);
    const template = Template.fromStack(stack);
    const json = JSON.stringify(template.toJSON());
    expect(json).toContain('sts:AssumeRole');
    expect(json).toContain('arn:aws:iam::222222222222:role/GuardianCdkDeployRole');
  });

  test('requires at least one target account', () => {
    expect(() => fleetStack([])).toThrow(/at least one target account/);
  });
});
