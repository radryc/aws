import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { StrataStack } from '../lib/strata-stack';
import { ObservabilityStack } from '../lib/observability-stack';

const ACCOUNT = '123456789012';
const REGION = 'us-east-1';

function makeStack(): ObservabilityStack {
  const app = new cdk.App();
  const strata = new StrataStack(app, 'ObsStrata', {
    env: { account: ACCOUNT, region: REGION },
  });
  return new ObservabilityStack(app, 'ObservabilityStack', {
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
    latticePrincipalAccounts: ['111111111111'],
  });
}

function makeSecureStack(): ObservabilityStack {
  const app = new cdk.App({
    context: {
      deploySSO: true,
      deployObservability: true,
    },
  });
  const strata = new StrataStack(app, 'SecureStrata', {
    env: { account: ACCOUNT, region: REGION },
  });
  expect(strata.doctorUrl).toBeDefined();
  return new ObservabilityStack(app, 'SecureObservability', {
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
    doctorUrl: strata.doctorUrl,
    userPoolId: strata.userPool?.userPoolId,
    cognitoDomain: strata.cognitoDomain?.domainName,
    guardianAccessPolicyToken: strata.guardianAccessPolicyToken,
  });
}

describe('ObservabilityStack', () => {
  test('provisions Doctor, OTLP gateway, and VPC Lattice', () => {
    const stack = makeStack();
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'doctor-ingest',
    });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'doctor-query',
    });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'guardian-otlp-gateway',
    });
    template.hasResourceProperties('AWS::VpcLattice::Service', {
      Name: 'strata-otlp',
    });
    template.hasResourceProperties('AWS::VpcLattice::ServiceNetwork', {
      Name: 'strata-observability',
    });
    template.hasResourceProperties('AWS::VpcLattice::TargetGroup', {
      Name: 'strata-otlp-gateway',
      Type: 'ALB',
    });
    template.hasOutput('OtlpServiceDns', {});
    template.hasOutput('OtlpServiceNetworkArn', {});
    template.hasOutput('OtlpIngestTokenSecretArn', {});
  });

  test('gateway accepts OTLP HTTP with bearer auth and queues to Doctor', () => {
    const stack = makeStack();
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'guardian-otlp-gateway',
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'AOT_CONFIG_CONTENT' }),
          ]),
          Secrets: Match.arrayWith([
            Match.objectLike({ Name: 'GUARDIAN_OTLP_INGEST_TOKEN' }),
          ]),
        }),
      ]),
    });
  });

  test('shares the Lattice service network with workload accounts', () => {
    const stack = makeStack();
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::RAM::ResourceShare', {
      Name: 'strata-observability-otlp',
      Principals: ['111111111111'],
    });
  });

  test('wires Doctor Cognito OIDC and Guardian partition enforcement', () => {
    const stack = makeSecureStack();
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ClientName: 'strata-doctor',
      GenerateSecret: true,
      AllowedOAuthFlows: ['code'],
    });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 8080,
    });
    const queryTask = Object.values(template.findResources('AWS::ECS::TaskDefinition'))
      .find((resource: any) => resource.Properties.Family === 'doctor-query') as any;
    expect(queryTask).toBeDefined();
    const container = queryTask.Properties.ContainerDefinitions[0];
    expect(container.Environment).toEqual(expect.arrayContaining([
      expect.objectContaining({ Name: 'DOCTOR_ACCESS_MODE', Value: 'enforce' }),
      expect.objectContaining({ Name: 'DOCTOR_AUTH_REQUIRE', Value: 'true' }),
      expect.objectContaining({ Name: 'DOCTOR_OIDC_REQUIRE_LOGIN', Value: 'true' }),
      expect.objectContaining({ Name: 'DOCTOR_ACCESS_POLICY_URL' }),
    ]));
    expect(container.Secrets).toEqual(expect.arrayContaining([
      expect.objectContaining({ Name: 'DOCTOR_ACCESS_POLICY_TOKEN' }),
      expect.objectContaining({ Name: 'DOCTOR_OIDC_CLIENT_SECRET' }),
    ]));
    template.hasOutput('DoctorAccessMode', { Value: 'enforce' });
  });
});
