#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { StrataStack } from '../lib/strata-stack';
import { AwsPusherStack } from '../lib/aws-pusher-stack';
import { AwsPusherFleetStack } from '../lib/aws-pusher-fleet-stack';
import { AwsObservedPusherStack } from '../lib/aws-observed-pusher-stack';
import { DemoStack } from '../lib/demo-stack';
import { ObservabilityStack } from '../lib/observability-stack';
import { ClientVpnStack } from '../lib/client-vpn-stack';

const app = new cdk.App();

function boolContext(key: string, fallback: boolean): boolean {
  const value = app.node.tryGetContext(key);
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  return !['false', '0', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

// Only pin an explicit environment when the CDK CLI has resolved an account
// (CDK_DEFAULT_ACCOUNT is injected by the CLI from the active profile). Passing
// an env with a concrete region but an undefined account makes the stacks
// part-environment-agnostic, which `cdk diff`/`deploy` reject with
// "Unable to resolve AWS account to use".
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region =
  process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || 'us-east-1';
const env = account ? { account, region } : undefined;

const strata = new StrataStack(app, 'StrataStack', {
  env,
  description: 'Strata — MonoFS + Guardian on ECS Fargate (CloudFormation)',
});

// The pusher is a sibling stack (deployed separately from StrataStack) so it
// can be managed/redeployed independently. It joins StrataStack's VPC,
// cluster and Service Connect namespace.
let awsPusherStack: AwsPusherStack | undefined;
if (boolContext('deployAwsPusher', true)) {
  awsPusherStack = new AwsPusherStack(app, 'AwsPusherStack', {
    env,
    description: 'Strata — AWS pusher (account scan + CDK deploys)',
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
}

// AWS-side observability plane: Doctor + OTLP gateway + VPC Lattice.
// Disable with `-c deployObservability=false`. The gateway partition defaults
// to `checkout` for the demo; override with `-c otlpPartition=...`.
let observabilityStack: ObservabilityStack | undefined;
if (boolContext('deployObservability', true)) {
  const latticePrincipals = String(
    app.node.tryGetContext('latticePrincipalAccounts') ?? '',
  )
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');

  const federationTokenARNs: Record<string, string> = {};
  const federationTokenContext = app.node.tryGetContext('doctorFederationTokenSecrets');
  if (federationTokenContext) {
    const parsed = typeof federationTokenContext === 'string'
      ? JSON.parse(federationTokenContext)
      : federationTokenContext;
    Object.entries(parsed as Record<string, string>).forEach(([envName, arn]) => {
      if (arn) federationTokenARNs[envName] = arn;
    });
  }

  observabilityStack = new ObservabilityStack(app, 'ObservabilityStack', {
    env,
    description: 'Strata — Doctor, OTLP gateway, and VPC Lattice endpoint',
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
    partition: String(app.node.tryGetContext('otlpPartition') ?? ''),
    stampAccount: boolContext('otlpStampAccount', false),
    latticePrincipalAccounts: latticePrincipals,
    federationEnabled: boolContext('doctorFederationEnabled', false),
    federationCatalogJSON: String(app.node.tryGetContext('doctorFederationCatalogJSON') ?? '') || undefined,
    federationTokenARNs,
    awsReadEndpoint: String(app.node.tryGetContext('awsReadEndpoint') ?? '') || (awsPusherStack ? `http://${awsPusherStack.readServiceDNS}:19090` : undefined),
    awsReadToken: awsPusherStack?.readToken,
    awsReadTokenArn: String(app.node.tryGetContext('awsReadTokenSecretArn') ?? '') || undefined,
    gatewayReplicas: Number(app.node.tryGetContext('otlpGatewayReplicas') ?? 1),
    doctorIngestReplicas: Number(app.node.tryGetContext('doctorIngestReplicas') ?? 1),
    doctorQueryReplicas: Number(app.node.tryGetContext('doctorQueryReplicas') ?? 1),
  });

  if (boolContext('deployClientVpn', false)) {
    const serverCertificateArn = String(app.node.tryGetContext('vpnServerCertificateArn') ?? '');
    const clientRootCertificateArn = String(app.node.tryGetContext('vpnClientRootCertificateArn') ?? '');
    // Pass the service-network ARN explicitly so ClientVpnStack does not need a
    // cross-stack export from ObservabilityStack that may not exist yet.
    const vpnServiceNetworkArn = String(app.node.tryGetContext('vpnServiceNetworkArn') ?? '');
    if (!serverCertificateArn || !clientRootCertificateArn) {
      throw new Error(
        'deployClientVpn=true requires -c vpnServerCertificateArn=... and -c vpnClientRootCertificateArn=...',
      );
    }
    new ClientVpnStack(app, 'ClientVpnStack', {
      env,
      description: 'Strata — AWS Client VPN for local kind connectivity',
      serviceNetworkArn: vpnServiceNetworkArn || observabilityStack.otlpServiceNetworkArn,
      gatewaySecurityGroup: strata.monofsSg,
      serverCertificateArn,
      clientRootCertificateArn,
    });
  }
}

// Small demo stack: S3 + SSM parameter + Secret + a tiny ECS Fargate service.
// Handy for demoing Guardian scan/import/deploy.
if (boolContext('deployDemoStack', true)) {
  new DemoStack(app, 'DemoStack', {
    env,
    description: 'Strata — demo stack for Guardian scan/import/deploy',
  });
}

// Multi-account pusher fleet (kind-mode demos use local Docker pushers; aws
// mode deploys one ECS service per target account here). Enabled by passing
// `-c fleetTargetAccounts=111111111111,222222222222`.
const fleetTargets = String(app.node.tryGetContext('fleetTargetAccounts') ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value !== '');
if (fleetTargets.length > 0) {
  new AwsPusherFleetStack(app, 'AwsPusherFleetStack', {
    env,
    description: 'Strata — AWS pusher fleet (one service per target account)',
    vpc: strata.vpc,
    cluster: strata.cluster,
    serviceConnectNamespace: strata.cloudMapNs,
    monofsSg: strata.monofsSg,
    vpcSubnets: strata.privateSubnets,
    monofsToken: strata.monofsToken,
    monofsRouterSvc: strata.monofsRouterSvc,
    targetAccounts: fleetTargets,
    pusherRegion: region,
    assumeRoleName: String(app.node.tryGetContext('fleetAssumeRoleName') ?? 'GuardianCdkDeployRole'),
  });
}

// Self-contained observed-only pusher (no MonoFS dependency). Useful when an
// account should be observed by Guardian without joining the main Strata
// cluster. Disabled by default.
if (boolContext('deployObservedPusher', false)) {
  new AwsObservedPusherStack(app, 'AwsObservedPusherStack', {
    env,
    description: 'Strata — self-contained AWS observed pusher',
  });
}

app.synth();
