import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ram from 'aws-cdk-lib/aws-ram';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as vpclattice from 'aws-cdk-lib/aws-vpclattice';
import { Construct, IConstruct } from 'constructs';
import { dockerImage } from './docker-assets';

export interface ObservabilityStackProps extends cdk.StackProps {
  /** Network + ECS cluster from StrataStack. */
  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  serviceConnectNamespace: servicediscovery.INamespace;
  monofsSg: ec2.ISecurityGroup;
  vpcSubnets: ec2.SubnetSelection;
  monofsToken: secretsmanager.ISecret;
  monofsRouterSvc?: IConstruct;

  /** Main Strata ALB, used for the Doctor query UI. */
  alb?: elb.IApplicationLoadBalancer;
  albListener?: elb.IApplicationListener;

  /** Public HTTPS CloudFront URL for Doctor (created by StrataStack). */
  doctorUrl?: string;
  /** Cognito user pool and hosted-UI domain prefix used by Doctor OIDC. */
  userPoolId?: string;
  cognitoDomain?: string;
  /** Guardian bearer token for the access-policy endpoint. */
  guardianAccessPolicyToken?: secretsmanager.ISecret;

  /** Optional fixed partition. Empty means preserve the application value. */
  partition?: string;

  /**
   * Stamp guardian.account/region from this stack. Enable when the gateway is
   * deployed inside the workload account; leave false for a shared gateway.
   */
  stampAccount?: boolean;

  /** Accounts that may associate their VPC with the Lattice service network. */
  latticePrincipalAccounts?: string[];

  /** Optional static Doctor federation catalog (JSON). */
  federationCatalogJSON?: string;
  federationEnabled?: boolean;
  /** Env name -> secret for token_env entries in the federation catalog. */
  federationTokenSecrets?: Record<string, secretsmanager.ISecret>;
  /** Env name -> complete Secrets Manager ARN. Imported inside this stack. */
  federationTokenARNs?: Record<string, string>;

  /** Optional legacy single AWS read backend. */
  awsReadEndpoint?: string;
  awsReadToken?: secretsmanager.ISecret;
  awsReadTokenArn?: string;

  gatewayReplicas?: number;
  doctorIngestReplicas?: number;
  doctorQueryReplicas?: number;
}

/**
 * AWS-side observability control plane:
 *   - doctor-ingest (OTLP -> MonoFS)
 *   - doctor-query (Doctor UI/API)
 *   - guardian-otlp-gateway (OTLP receiver -> doctor-ingest)
 *   - VPC Lattice service network/service for the OTLP endpoint
 *
 * The gateway is deliberately separate from the pusher control plane. It can
 * be scaled and restarted without affecting deployments.
 */
export class ObservabilityStack extends cdk.Stack {
  public readonly otlpServiceNetworkArn: string;
  public readonly otlpServiceDns: string;
  public readonly ingestToken: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    const accountId = this.account;
    const region = this.region;
    const partition = (props.partition || '').trim();
    const gatewayReplicas = props.gatewayReplicas ?? 1;
    const ingestReplicas = props.doctorIngestReplicas ?? 1;
    const queryReplicas = props.doctorQueryReplicas ?? 1;

    // MVP uses the existing MonoFS security group so Doctor can reach the
    // router and the gateway can reach Doctor without mutating a StrataStack
    // resource from this stack (which would create a cross-stack cycle).
    const observabilitySg = props.monofsSg;

    const execRole = new iam.Role(this, 'ObservabilityExecRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });
    props.monofsToken.grantRead(execRole);

    const logsGroup = new logs.LogGroup(this, 'ObservabilityLogs', {
      logGroupName: '/ecs/strata-observability',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const logDriver = ecs.LogDrivers.awsLogs({ streamPrefix: 'observability', logGroup: logsGroup });

    const privacyKey = new secretsmanager.Secret(this, 'DoctorPrivacyKey', {
      secretName: 'strata/doctor/privacy-hmac-key',
      description: 'Doctor privacy HMAC key',
      generateSecretString: { excludePunctuation: true, passwordLength: 48 },
    });
    privacyKey.grantRead(execRole);

    const ingestToken = new secretsmanager.Secret(this, 'OtlpIngestToken', {
      secretName: 'strata/guardian/otlp-ingest-token',
      description: 'Bearer token accepted by the Strata OTLP gateway',
      generateSecretString: { excludePunctuation: true, passwordLength: 48 },
    });
    ingestToken.grantRead(execRole);
    this.ingestToken = ingestToken;

    const docker = (service: string) =>
      dockerImage('doctor.Dockerfile', { buildArgs: { DOCTOR_SERVICE: service } });

    // ────────────────────────────────────────────────────────────
    // Doctor ingest
    // ────────────────────────────────────────────────────────────
    const ingestTask = new ecs.FargateTaskDefinition(this, 'DoctorIngestTask', {
      family: 'doctor-ingest',
      cpu: 1024,
      memoryLimitMiB: 2048,
      executionRole: execRole,
    });
    ingestTask.addContainer('doctor-ingest', {
      image: docker('doctor-ingest'),
      logging: logDriver,
      portMappings: [
        { name: 'otlp-grpc', containerPort: 4317, protocol: ecs.Protocol.TCP },
        { name: 'otlp-http', containerPort: 4318, protocol: ecs.Protocol.TCP },
      ],
      environment: {
        DOCTOR_GRPC_ADDR: ':4317',
        DOCTOR_HTTP_ADDR: ':4318',
        DOCTOR_MONOFS_LOGENGINE_ADDR: 'monofs-router:9090',
        DOCTOR_DEFAULT_TENANT: 'default',
        DOCTOR_DEFAULT_PARTITION: 'doctor',
        DOCTOR_TENANT_HEADER: 'X-Doctor-Tenant',
        DOCTOR_TRACE_BUFFER_FLUSH_INTERVAL: '5s',
        DOCTOR_TRACE_BUFFER_MAX_RECORDS: '50000',
        DOCTOR_TRACE_BUFFER_WAL_DIR: '/tmp/doctor/trace-buffer',
        DOCTOR_LOG_BUFFER_FLUSH_INTERVAL: '5s',
        DOCTOR_LOG_BUFFER_WAL_DIR: '/tmp/doctor/log-buffer',
        DOCTOR_METRIC_BUFFER_FLUSH_INTERVAL: '5s',
        DOCTOR_METRIC_BUFFER_WAL_DIR: '/tmp/doctor/metric-buffer',
        OTEL_GO_DISABLED_INSTRUMENTATIONS: 'nethttp,grpc',
      },
      secrets: {
        DOCTOR_MONOFS_TOKEN: ecs.Secret.fromSecretsManager(props.monofsToken),
        DOCTOR_PRIVACY_HMAC_KEY: ecs.Secret.fromSecretsManager(privacyKey),
      },
    });
    const ingestService = new ecs.FargateService(this, 'DoctorIngestSvc', {
      cluster: props.cluster,
      taskDefinition: ingestTask,
      desiredCount: ingestReplicas,
      securityGroups: [observabilitySg],
      vpcSubnets: props.vpcSubnets,
      assignPublicIp: false,
      serviceConnectConfiguration: {
        namespace: props.serviceConnectNamespace.namespaceName,
        services: [
          { portMappingName: 'otlp-grpc', dnsName: 'doctor-ingest', port: 4317 },
          { portMappingName: 'otlp-http', dnsName: 'doctor-ingest-http', port: 4318 },
        ],
      },
      minHealthyPercent: 0,
      maxHealthyPercent: 200,
      circuitBreaker: { rollback: true },
    });
    ingestService.node.addDependency(props.serviceConnectNamespace);
    if (props.monofsRouterSvc) {
      ingestService.node.addDependency(props.monofsRouterSvc);
    }

    // ────────────────────────────────────────────────────────────
    // Doctor query
    // ────────────────────────────────────────────────────────────
    const queryTask = new ecs.FargateTaskDefinition(this, 'DoctorQueryTask', {
      family: 'doctor-query',
      cpu: 1024,
      memoryLimitMiB: 2048,
      executionRole: execRole,
    });
    const queryEnv: Record<string, string> = {
      DOCTOR_QUERY_HTTP_ADDR: ':18080',
      DOCTOR_MONOFS_LOGENGINE_ADDR: 'monofs-router:9090',
      DOCTOR_DEFAULT_TENANT: 'default',
      DOCTOR_DEFAULT_PARTITION: 'doctor',
      DOCTOR_ACCESS_MODE: 'observe',
      // The legacy endpoint resolver is not the partition RBAC path. Doctor
      // filters logs/traces through the Guardian PolicyGate configured below.
      DOCTOR_ACCESS_RESOLVER: 'allow-all',
      DOCTOR_SESSION_DIR: '/tmp/doctor-sessions',
      DOCTOR_GUARDIAN_API_URL: 'http://guardiand:8090',
      DOCTOR_SENTINEL_URL: 'http://doctor-sentinel:18082',
      OTEL_GO_DISABLED_INSTRUMENTATIONS: 'nethttp,grpc',
    };
    if (props.federationEnabled) {
      queryEnv.DOCTOR_FEDERATION_ENABLED = 'true';
    }
    if (props.federationCatalogJSON) {
      queryEnv.DOCTOR_FEDERATION_CATALOG_JSON = props.federationCatalogJSON;
    }
    if (props.awsReadEndpoint) {
      queryEnv.DOCTOR_AWS_ENABLED = 'true';
      queryEnv.DOCTOR_AWS_BACKEND_URL = props.awsReadEndpoint;
    }
    const querySecrets: Record<string, ecs.Secret> = {
      DOCTOR_MONOFS_TOKEN: ecs.Secret.fromSecretsManager(props.monofsToken),
    };
    if (props.guardianAccessPolicyToken) {
      props.guardianAccessPolicyToken.grantRead(execRole);
      querySecrets.DOCTOR_ACCESS_POLICY_TOKEN = ecs.Secret.fromSecretsManager(
        props.guardianAccessPolicyToken,
      );
      queryEnv.DOCTOR_ACCESS_POLICY_URL = 'http://guardiand:8090/api/access/policy';
    }
    const awsReadToken = props.awsReadToken
      || (props.awsReadTokenArn
        ? secretsmanager.Secret.fromSecretCompleteArn(this, 'AwsReadToken', props.awsReadTokenArn)
        : undefined);
    if (awsReadToken) {
      awsReadToken.grantRead(execRole);
      querySecrets.DOCTOR_AWS_BACKEND_TOKEN = ecs.Secret.fromSecretsManager(awsReadToken);
    }
    for (const [envName, secret] of Object.entries(props.federationTokenSecrets || {})) {
      secret.grantRead(execRole);
      querySecrets[envName] = ecs.Secret.fromSecretsManager(secret);
    }
    for (const [envName, arn] of Object.entries(props.federationTokenARNs || {})) {
      if (!arn) continue;
      const secret = secretsmanager.Secret.fromSecretCompleteArn(
        this,
        `FederationToken${envName.replace(/[^A-Za-z0-9]/g, '')}`,
        arn,
      );
      secret.grantRead(execRole);
      querySecrets[envName] = ecs.Secret.fromSecretsManager(secret);
    }

    // Doctor's own Cognito app client. It is created here (not in StrataStack)
    // because its callback URL depends on the CloudFront domain created there.
    // The public URL is passed in as a token, so there is no dependency cycle
    // with the Doctor service.
    let doctorOidcClientId: string | undefined;
    if (props.doctorUrl && props.alb && props.userPoolId && props.cognitoDomain) {
      const oidcClient = new cognito.CfnUserPoolClient(this, 'DoctorOidcClient', {
        userPoolId: props.userPoolId,
        clientName: 'strata-doctor',
        generateSecret: true,
        allowedOAuthFlowsUserPoolClient: true,
        allowedOAuthFlows: ['code'],
        allowedOAuthScopes: ['openid', 'email', 'profile'],
        callbackUrLs: [`${props.doctorUrl}/auth/callback`],
        logoutUrLs: [`${props.doctorUrl}/`],
        supportedIdentityProviders: ['COGNITO'],
        preventUserExistenceErrors: 'ENABLED',
        enableTokenRevocation: true,
      });
      doctorOidcClientId = oidcClient.attrClientId;

      const oidcClientSecret = new secretsmanager.Secret(this, 'DoctorOidcClientSecret', {
        secretName: 'strata/doctor/cognito-client-secret',
        description: 'Cognito app client secret for Doctor OIDC',
        secretStringValue: cdk.SecretValue.unsafePlainText(oidcClient.attrClientSecret),
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      oidcClientSecret.grantRead(execRole);
      querySecrets.DOCTOR_OIDC_CLIENT_SECRET = ecs.Secret.fromSecretsManager(oidcClientSecret);

      const hostedUi = `https://${props.cognitoDomain}.auth.${region}.amazoncognito.com`;
      queryEnv.DOCTOR_OIDC_ISSUER = `https://cognito-idp.${region}.amazonaws.com/${props.userPoolId}`;
      queryEnv.DOCTOR_OIDC_AUDIENCE = doctorOidcClientId;
      queryEnv.DOCTOR_OIDC_CLIENT_ID = doctorOidcClientId;
      queryEnv.DOCTOR_OIDC_AUTH_URL = `${hostedUi}/oauth2/authorize`;
      queryEnv.DOCTOR_OIDC_REDIRECT_URL = `${props.doctorUrl}/auth/callback`;
      queryEnv.DOCTOR_OIDC_SCOPES = 'openid,email,profile';
      queryEnv.DOCTOR_AUTH_REQUIRE = 'true';
      queryEnv.DOCTOR_OIDC_REQUIRE_LOGIN = 'true';

      if (props.guardianAccessPolicyToken) {
        // The PolicyGate is the partition RBAC layer; it filters logs and
        // traces by guardian_partition. Metrics remain visible by design.
        queryEnv.DOCTOR_ACCESS_MODE = 'enforce';
      }
    }
    if (queryEnv.DOCTOR_ACCESS_MODE !== 'enforce') {
      cdk.Annotations.of(this).addWarning(
        'Doctor OIDC or the Guardian access-policy token is missing; Doctor remains in observe mode.',
      );
    }

    queryTask.addContainer('doctor-query', {
      image: docker('doctor-query'),
      logging: logDriver,
      portMappings: [{ name: 'http', containerPort: 18080, protocol: ecs.Protocol.TCP }],
      environment: queryEnv,
      secrets: querySecrets,
    });
    const queryService = new ecs.FargateService(this, 'DoctorQuerySvc', {
      cluster: props.cluster,
      taskDefinition: queryTask,
      desiredCount: queryReplicas,
      securityGroups: [observabilitySg],
      vpcSubnets: props.vpcSubnets,
      assignPublicIp: false,
      serviceConnectConfiguration: {
        namespace: props.serviceConnectNamespace.namespaceName,
        services: [{ portMappingName: 'http', dnsName: 'doctor-query', port: 18080 }],
      },
      minHealthyPercent: 0,
      maxHealthyPercent: 200,
      circuitBreaker: { rollback: true },
    });
    queryService.node.addDependency(props.serviceConnectNamespace);
    if (props.monofsRouterSvc) {
      queryService.node.addDependency(props.monofsRouterSvc);
    }

    // ────────────────────────────────────────────────────────────
    // Doctor Sentinel: alert routing, delivery, rules, and subspace alerts
    // ────────────────────────────────────────────────────────────
    const sentinelTask = new ecs.FargateTaskDefinition(this, 'DoctorSentinelTask', {
      family: 'doctor-sentinel',
      cpu: 512,
      memoryLimitMiB: 1024,
      executionRole: execRole,
    });
    const sentinelEnv: Record<string, string> = {
      DOCTOR_SENTINEL_HTTP_ADDR: ':18082',
      DOCTOR_SENTINEL_QUERY_URL: 'http://doctor-query:18080',
      DOCTOR_SENTINEL_MONOFS_LOGENGINE_ADDR: 'monofs-router:9090',
      DOCTOR_SENTINEL_DEFAULT_TENANT: 'default',
      DOCTOR_SENTINEL_STORE_ROOT: '/doctor/v1/alerts',
      DOCTOR_SENTINEL_DELIVERY_ENABLED: 'true',
      // The query proxy forwards identity headers. Keep allow-all disabled in
      // production once partition-access headers are wired end to end.
      DOCTOR_SENTINEL_AUTH_ALLOW_ALL: 'false',
      OTEL_GO_DISABLED_INSTRUMENTATIONS: 'nethttp,grpc',
    };
    const sentinelGuardianHMAC = new secretsmanager.Secret(this, 'SentinelGuardianHMAC', {
      secretName: 'strata/doctor/sentinel-guardian-hmac',
      description: 'HMAC secret for Guardian -> Sentinel alert intake',
      generateSecretString: { excludePunctuation: true, passwordLength: 48 },
    });
    sentinelGuardianHMAC.grantRead(execRole);
    const sentinelSecrets: Record<string, ecs.Secret> = {
      DOCTOR_MONOFS_TOKEN: ecs.Secret.fromSecretsManager(props.monofsToken),
      DOCTOR_SENTINEL_GUARDIAN_HMAC_SECRET: ecs.Secret.fromSecretsManager(sentinelGuardianHMAC),
    };
    if (props.awsReadEndpoint) {
      sentinelEnv.DOCTOR_SENTINEL_AWS_ENABLED = 'true';
      sentinelEnv.DOCTOR_SENTINEL_AWS_URL = props.awsReadEndpoint;
    }
    if (awsReadToken) {
      awsReadToken.grantRead(execRole);
      sentinelSecrets.DOCTOR_SENTINEL_AWS_TOKEN = ecs.Secret.fromSecretsManager(awsReadToken);
    }
    sentinelTask.addContainer('doctor-sentinel', {
      image: docker('doctor-sentinel'),
      logging: logDriver,
      portMappings: [{ name: 'http', containerPort: 18082, protocol: ecs.Protocol.TCP }],
      environment: sentinelEnv,
      secrets: sentinelSecrets,
    });
    const sentinelService = new ecs.FargateService(this, 'DoctorSentinelSvc', {
      cluster: props.cluster,
      taskDefinition: sentinelTask,
      desiredCount: 1,
      securityGroups: [observabilitySg],
      vpcSubnets: props.vpcSubnets,
      assignPublicIp: false,
      serviceConnectConfiguration: {
        namespace: props.serviceConnectNamespace.namespaceName,
        services: [{ portMappingName: 'http', dnsName: 'doctor-sentinel', port: 18082 }],
      },
      minHealthyPercent: 0,
      maxHealthyPercent: 200,
      circuitBreaker: { rollback: true },
    });
    sentinelService.node.addDependency(props.serviceConnectNamespace);
    if (props.monofsRouterSvc) {
      sentinelService.node.addDependency(props.monofsRouterSvc);
    }
    new cdk.CfnOutput(this, 'SentinelGuardianHMACSecretArn', {
      value: sentinelGuardianHMAC.secretArn,
      description: 'Configure Guardian notifications with a webhook to Sentinel using this HMAC secret',
    });

    // Public Doctor shares the Strata ALB through a dedicated :8080 listener.
    // CloudFront terminates HTTPS and forwards root-relative Doctor UI paths
    // unchanged to that listener. If OIDC is not configured, keep the original
    // internal ALB so Doctor is never exposed without authentication.
    let queryUrl: string;
    let queryAlbDns: string;
    let publicListener: elb.ApplicationListener | undefined;
    if (props.doctorUrl && props.alb) {
      publicListener = new elb.ApplicationListener(this, 'DoctorPublicListener', {
        loadBalancer: props.alb,
        port: 8080,
        protocol: elb.ApplicationProtocol.HTTP,
        open: false,
      });
      publicListener.addTargets('Query', {
        port: 18080,
        protocol: elb.ApplicationProtocol.HTTP,
        targets: [queryService.loadBalancerTarget({ containerName: 'doctor-query', containerPort: 18080 })],
        healthCheck: { path: '/healthz', healthyHttpCodes: '200' },
      });
      queryUrl = props.doctorUrl;
      queryAlbDns = props.alb.loadBalancerDnsName;
    } else {
      const queryAlb = new elb.ApplicationLoadBalancer(this, 'DoctorQueryAlb', {
        vpc: props.vpc,
        internetFacing: false,
        securityGroup: observabilitySg,
        vpcSubnets: props.vpcSubnets,
      });
      queryAlb.addListener('Http', { port: 80, open: false }).addTargets('Query', {
        port: 18080,
        protocol: elb.ApplicationProtocol.HTTP,
        targets: [queryService.loadBalancerTarget({ containerName: 'doctor-query', containerPort: 18080 })],
        healthCheck: { path: '/healthz', healthyHttpCodes: '200' },
      });
      queryUrl = `http://${queryAlb.loadBalancerDnsName}`;
      queryAlbDns = queryAlb.loadBalancerDnsName;
    }

    // ────────────────────────────────────────────────────────────
    // OTLP gateway
    // ────────────────────────────────────────────────────────────
    const gatewayConfig = {
      receivers: {
        otlp: {
          protocols: {
            grpc: {
              endpoint: '0.0.0.0:4317',
              auth: { authenticator: 'bearertokenauth' },
            },
            http: {
              endpoint: '0.0.0.0:4318',
              auth: { authenticator: 'bearertokenauth' },
            },
          },
        },
      },
      processors: {
        memory_limiter: { check_interval: '1s', limit_mib: 512 },
        resource: {
          attributes: [
            { key: 'guardian.provider', value: 'aws', action: 'upsert' },
            { key: 'guardian.pusher', value: 'aws-otlp-gateway', action: 'upsert' },
            ...(props.stampAccount
              ? [
                  { key: 'guardian.account', value: accountId, action: 'upsert' },
                  { key: 'guardian.region', value: region, action: 'upsert' },
                ]
              : []),
            ...(partition
              ? [{ key: 'guardian.partition', value: partition, action: 'upsert' }]
              : []),
          ],
        },
        batch: { timeout: '5s', send_batch_size: 8192 },
      },
      exporters: {
        'otlphttp/doctor': {
          endpoint: 'http://doctor-ingest-http:4318',
          // The OTLP HTTP exporter defaults to gzip. Doctor's ingest reads the
          // body as raw protobuf, so this internal VPC hop must be uncompressed.
          compression: 'none',
          headers: { 'x-doctor-tenant': 'default' },
          sending_queue: { enabled: true, storage: 'file_storage', queue_size: 10000 },
          retry_on_failure: {
            enabled: true,
            initial_interval: '1s',
            max_interval: '30s',
            max_elapsed_time: '10m',
          },
        },
      },
      extensions: {
        health_check: { endpoint: '0.0.0.0:13133' },
        file_storage: { directory: '/var/lib/otelcol', timeout: '10s', create_directory: true },
        bearertokenauth: {
          scheme: 'Bearer',
          token: '${env:GUARDIAN_OTLP_INGEST_TOKEN}',
        },
      },
      service: {
        extensions: ['health_check', 'file_storage', 'bearertokenauth'],
        pipelines: {
          traces: {
            receivers: ['otlp'],
            processors: ['memory_limiter', 'resource', 'batch'],
            exporters: ['otlphttp/doctor'],
          },
          metrics: {
            receivers: ['otlp'],
            processors: ['memory_limiter', 'resource', 'batch'],
            exporters: ['otlphttp/doctor'],
          },
          logs: {
            receivers: ['otlp'],
            processors: ['memory_limiter', 'resource', 'batch'],
            exporters: ['otlphttp/doctor'],
          },
        },
      },
    };

    const gatewayTask = new ecs.FargateTaskDefinition(this, 'OtlpGatewayTask', {
      family: 'guardian-otlp-gateway',
      cpu: 512,
      memoryLimitMiB: 1024,
      executionRole: execRole,
    });
    gatewayTask.addVolume({ name: 'otel-queue' });
    const gatewayContainer = gatewayTask.addContainer('otel-collector', {
      image: ecs.ContainerImage.fromRegistry('otel/opentelemetry-collector-contrib:0.149.0'),
      command: ['--config=env:AOT_CONFIG_CONTENT'],
      // The upstream contrib image is non-root by default, but the ephemeral
      // Fargate volume is root-owned. Run as root for the MVP so file_storage
      // can create its queue directory.
      user: '0',
      logging: logDriver,
      portMappings: [
        { name: 'gateway-otlp-http', containerPort: 4318, protocol: ecs.Protocol.TCP },
        { name: 'gateway-otlp-grpc', containerPort: 4317, protocol: ecs.Protocol.TCP },
        { name: 'gateway-health', containerPort: 13133, protocol: ecs.Protocol.TCP },
      ],
      environment: {
        AOT_CONFIG_CONTENT: JSON.stringify(gatewayConfig),
        AWS_REGION: region,
        ...(partition ? { GUARDIAN_OTLP_PARTITION: partition } : {}),
      },
      secrets: {
        GUARDIAN_OTLP_INGEST_TOKEN: ecs.Secret.fromSecretsManager(ingestToken),
      },
    });
    gatewayContainer.addMountPoints({ sourceVolume: 'otel-queue', containerPath: '/var/lib/otelcol', readOnly: false });
    const gatewayService = new ecs.FargateService(this, 'OtlpGatewaySvc', {
      cluster: props.cluster,
      taskDefinition: gatewayTask,
      desiredCount: gatewayReplicas,
      securityGroups: [observabilitySg],
      vpcSubnets: props.vpcSubnets,
      assignPublicIp: false,
      serviceConnectConfiguration: {
        namespace: props.serviceConnectNamespace.namespaceName,
        services: [{ portMappingName: 'gateway-otlp-http', dnsName: 'guardian-otlp', port: 4318 }],
      },
      minHealthyPercent: 0,
      maxHealthyPercent: 200,
      circuitBreaker: { rollback: true },
    });
    gatewayService.node.addDependency(ingestService);
    gatewayService.node.addDependency(props.serviceConnectNamespace);

    // VPC Lattice private DNS resolves to 169.254.x link-local service IPs,
    // which are not routable over AWS Client VPN. Expose the token-protected
    // OTLP HTTP receiver through the existing public ALB so the local kind
    // workload can send traces without a VPC route. Division apps inside AWS
    // still use the Lattice endpoint.
    if (publicListener && props.alb) {
      const publicOtlpTargets = new elb.ApplicationTargetGroup(this, 'OtlpPublicTargets', {
        vpc: props.vpc,
        port: 4318,
        protocol: elb.ApplicationProtocol.HTTP,
        targets: [gatewayService.loadBalancerTarget({ containerName: 'otel-collector', containerPort: 4318 })],
        healthCheck: { path: '/', port: '13133', healthyHttpCodes: '200' },
      });
      new elb.ApplicationListenerRule(this, 'OtlpPublicRule', {
        listener: publicListener,
        priority: 5,
        conditions: [elb.ListenerCondition.pathPatterns(['/v1/traces', '/v1/logs', '/v1/metrics'])],
        action: elb.ListenerAction.forward([publicOtlpTargets]),
      });
      new cdk.CfnOutput(this, 'OtlpPublicUrl', {
        value: `http://${props.alb.loadBalancerDnsName}:8080`,
        description: 'Token-protected OTLP/HTTP ingress for local kind',
      });
    }

    // Internal ALB in front of the gateway so VPC Lattice can use an ALB target
    // group. OTLP/HTTP is used for the MVP; gRPC stays available inside the VPC.
    const intakeAlb = new elb.ApplicationLoadBalancer(this, 'OtlpIntakeAlb', {
      vpc: props.vpc,
      internetFacing: false,
      securityGroup: observabilitySg,
      vpcSubnets: props.vpcSubnets,
    });
    intakeAlb
      .addListener('OtlpHttp', { port: 4318, protocol: elb.ApplicationProtocol.HTTP, open: false })
      .addTargets('Gateway', {
        port: 4318,
        protocol: elb.ApplicationProtocol.HTTP,
        targets: [gatewayService.loadBalancerTarget({ containerName: 'otel-collector', containerPort: 4318 })],
        healthCheck: { path: '/', port: '13133', healthyHttpCodes: '200' },
      });

    // ────────────────────────────────────────────────────────────
    // VPC Lattice
    // ────────────────────────────────────────────────────────────
    const serviceNetwork = new vpclattice.CfnServiceNetwork(this, 'OtlpServiceNetwork', {
      name: 'strata-observability',
      authType: 'NONE',
    });

    const targetGroup = new vpclattice.CfnTargetGroup(this, 'OtlpTargetGroup', {
      name: 'strata-otlp-gateway',
      type: 'ALB',
      config: {
        port: 4318,
        protocol: 'HTTP',
        protocolVersion: 'HTTP1',
        vpcIdentifier: props.vpc.vpcId,
      },
      targets: [{ id: intakeAlb.loadBalancerArn }],
    });

    const otlpService = new vpclattice.CfnService(this, 'OtlpService', {
      name: 'strata-otlp',
      authType: 'NONE',
    });

    new vpclattice.CfnListener(this, 'OtlpListener', {
      name: 'otlp-http',
      protocol: 'HTTP',
      port: 4318,
      serviceIdentifier: otlpService.attrArn,
      defaultAction: {
        forward: {
          targetGroups: [{ targetGroupIdentifier: targetGroup.attrArn, weight: 100 }],
        },
      },
    });

    new vpclattice.CfnServiceNetworkServiceAssociation(this, 'OtlpServiceAssociation', {
      serviceNetworkIdentifier: serviceNetwork.attrArn,
      serviceIdentifier: otlpService.attrArn,
    });

    const latticeSg = new ec2.SecurityGroup(this, 'LatticeVpcSg', {
      vpc: props.vpc,
      description: 'VPC Lattice service network association',
      allowAllOutbound: true,
    });
    latticeSg.addIngressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(4318),
      'VPC workloads to Lattice OTLP',
    );
    new vpclattice.CfnServiceNetworkVpcAssociation(this, 'OtlpVpcAssociation', {
      serviceNetworkIdentifier: serviceNetwork.attrArn,
      vpcIdentifier: props.vpc.vpcId,
      securityGroupIds: [latticeSg.securityGroupId],
      privateDnsEnabled: true,
    });

    const principals = (props.latticePrincipalAccounts || []).filter((v) => v.trim() !== '');
    if (principals.length > 0) {
      new ram.CfnResourceShare(this, 'OtlpServiceNetworkShare', {
        name: 'strata-observability-otlp',
        allowExternalPrincipals: true,
        resourceArns: [serviceNetwork.attrArn],
        principals,
      });

      // RAM sharing alone is not enough for a participant account to create a
      // VPC association. The service network also needs a resource policy that
      // allows the participant principals to call the association API.
      new vpclattice.CfnResourcePolicy(this, 'OtlpServiceNetworkPolicy', {
        resourceArn: serviceNetwork.attrArn,
        policy: {
          Version: '2012-10-17',
          Statement: [{
            Effect: 'Allow',
            Principal: { AWS: principals.map((account) => `arn:aws:iam::${account}:root`) },
            Action: ['vpc-lattice:CreateServiceNetworkVpcAssociation'],
            Resource: serviceNetwork.attrArn,
          }],
        },
      });
    }

    this.otlpServiceNetworkArn = serviceNetwork.attrArn;
    this.otlpServiceDns = otlpService.attrDnsEntryDomainName;

    new cdk.CfnOutput(this, 'OtlpServiceDns', {
      value: otlpService.attrDnsEntryDomainName,
      description: 'VPC Lattice DNS name for the OTLP gateway; use http://<dns>:4318',
    });
    new cdk.CfnOutput(this, 'OtlpServiceNetworkArn', {
      value: serviceNetwork.attrArn,
      description: 'Share/associate this service network with workload VPCs',
    });
    new cdk.CfnOutput(this, 'OtlpIngestTokenSecretArn', {
      value: ingestToken.secretArn,
      description: 'Bearer token accepted by the OTLP gateway',
    });
    new cdk.CfnOutput(this, 'DoctorQueryUrl', {
      value: queryUrl,
      description: 'Doctor UI/API (HTTPS with Cognito OIDC when public)',
    });
    new cdk.CfnOutput(this, 'DoctorQueryAlbDns', {
      value: queryAlbDns,
      description: 'ALB behind the Doctor HTTPS edge',
    });
    new cdk.CfnOutput(this, 'DoctorAccessMode', {
      value: queryEnv.DOCTOR_ACCESS_MODE,
      description: 'Doctor log/trace access policy mode',
    });
    if (doctorOidcClientId) {
      new cdk.CfnOutput(this, 'DoctorCognitoClientId', {
        value: doctorOidcClientId,
        description: 'Cognito app client used by Doctor OIDC',
      });
    }
  }
}
