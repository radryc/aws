import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as customResources from 'aws-cdk-lib/custom-resources';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';
import { dockerImage } from './docker-assets';

export class StrataStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly cluster: ecs.Cluster;
  public readonly cloudMapNs: servicediscovery.PrivateDnsNamespace;
  public readonly monofsToken: secretsmanager.Secret;
  public readonly monofsSg: ec2.SecurityGroup;
  public readonly privateSubnets: ec2.SubnetSelection;
  public readonly alb: elb.ApplicationLoadBalancer;
  public readonly albListener: elb.ApplicationListener;
  public readonly monofsTokenSecret: secretsmanager.Secret;
  public readonly guardianAccessPolicyToken: secretsmanager.Secret;
  public monofsServerSvc?: ecs.FargateService;
  public monofsRouterSvc?: ecs.FargateService;
  public monofsRouterNlbDns?: string;
  /** HTTPS CloudFront URL for Doctor when SSO + observability are enabled. */
  public doctorUrl?: string;
  public userPool?: cognito.UserPool;
  public userPoolClient?: cognito.UserPoolClient;
  public cognitoDomain?: cognito.UserPoolDomain;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const ctx = (key: string, defaultVal: any): any => this.node.tryGetContext(key) ?? defaultVal;
    const ctxBool = (key: string, defaultVal: boolean): boolean => {
      const value = this.node.tryGetContext(key);
      if (value === undefined || value === null || value === '') {
        return defaultVal;
      }
      if (typeof value === 'boolean') {
        return value;
      }
      return !['false', '0', 'no', 'off'].includes(String(value).trim().toLowerCase());
    };

    const deployMonofsServer = ctxBool('deployMonofsServer', true);
    const deployMonofsRouter = ctxBool('deployMonofsRouter', true);
    const deployMonofsFetcher = ctxBool('deployMonofsFetcher', true);
    const deployMonofsRegistry = ctxBool('deployMonofsRegistry', false);
    const deployMonofsSearch = ctxBool('deployMonofsSearch', false);
    const deployGuardian = ctxBool('deployGuardian', true);
    const deploySSO = ctxBool('deploySSO', false);

    const serverCount = ctx('serverCount', 1);
    const routerCount = ctx('routerCount', 1);
    const fetcherCount = ctx('fetcherCount', 1);
    const guardianCount = ctx('guardianCount', 1);

    const accountId = cdk.Stack.of(this).account;
    const region = cdk.Stack.of(this).region;

    // ═══════════════════════════════════════════════════════════════
    // NETWORK
    // ═══════════════════════════════════════════════════════════════
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    vpc.addGatewayEndpoint('S3Endpoint', { service: ec2.GatewayVpcEndpointAwsService.S3 });

    const privateSubnets = vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS });
    this.vpc = vpc;
    this.privateSubnets = privateSubnets;

    // ═══════════════════════════════════════════════════════════════
    // SECURITY GROUPS
    // ═══════════════════════════════════════════════════════════════
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      description: 'ALB ingress',
      allowAllOutbound: false,
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP from internet');
    albSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.allTcp(), 'ALB to ECS tasks');

    const monofsSg = new ec2.SecurityGroup(this, 'MonofsSg', {
      vpc,
      description: 'Monofs services',
      allowAllOutbound: true,
    });
    this.monofsSg = monofsSg;
    monofsSg.addIngressRule(monofsSg, ec2.Port.allTcp(), 'Internode for monofs components');
    monofsSg.addIngressRule(albSg, ec2.Port.allTcp(), 'ALB to monofs (router HTTP)');
    // Observability plane (Doctor + OTLP gateway) runs in this group. Allow
    // in-VPC and VPC Lattice traffic to the gateway and Doctor UI.
    monofsSg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(4318), 'VPC/Lattice to OTLP HTTP');
    monofsSg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(4317), 'VPC to OTLP gRPC');
    monofsSg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(13133), 'VPC to OTLP gateway health');
    monofsSg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(18080), 'VPC to Doctor query');

    const guardianSg = new ec2.SecurityGroup(this, 'GuardianSg', {
      vpc,
      description: 'Guardian services',
      allowAllOutbound: true,
    });

    // Guardian connects to monofs-router gRPC on 9090 — the monofs SG must allow this
    monofsSg.addIngressRule(guardianSg, ec2.Port.tcp(9090), 'Guardian to monofs-router gRPC');
    // Guardian's store client also discovers and dials the storage nodes
    // directly (sharded reads) rather than only via the router, so allow node
    // gRPC from Guardian too. Without this the node connections are silently
    // dropped by the SG and surface as "connection reset by peer".
    monofsSg.addIngressRule(guardianSg, ec2.Port.tcp(9000), 'Guardian to monofs-server gRPC');
    // Doctor runs in the MonoFS security group and polls Guardian's
    // /api/access/policy endpoint through Service Connect.
    guardianSg.addIngressRule(monofsSg, ec2.Port.tcp(8090), 'Doctor policy poller to Guardian');

    const efsSg = new ec2.SecurityGroup(this, 'EfsSg', {
      vpc,
      description: 'EFS NFS',
      allowAllOutbound: false,
    });
    efsSg.addIngressRule(monofsSg, ec2.Port.tcp(2049), 'NFS from monofs tasks');

    // ═══════════════════════════════════════════════════════════════
    // ECS CLUSTER
    // ═══════════════════════════════════════════════════════════════
    const cluster = new ecs.Cluster(this, 'EcsCluster', {
      vpc,
      clusterName: 'strata',
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });
    this.cluster = cluster;

    const cloudMapNs = new servicediscovery.PrivateDnsNamespace(this, 'ServiceDiscoveryNs', {
      name: 'strata.local',
      vpc,
    });
    (cloudMapNs.node.defaultChild as cdk.CfnResource).applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    this.cloudMapNs = cloudMapNs;

    // ═══════════════════════════════════════════════════════════════
    // SECRETS
    // ═══════════════════════════════════════════════════════════════
    const encryptionKey = new secretsmanager.Secret(this, 'MonofsEncryptionKey', {
      secretName: 'strata/monofs/encryption-key',
      description: 'Monofs 32-byte encryption key (64 hex chars), auto-generated at creation',
      generateSecretString: {
        excludePunctuation: true,
        excludeCharacters: 'ABCDEFGHIJKLMNOPQRSTUVWXYZghijklmnopqrstuvwxyz',
        passwordLength: 64,
        requireEachIncludedType: false,
      },
    });

    const monofsToken = new secretsmanager.Secret(this, 'MonofsToken', {
      secretName: 'strata/monofs/token',
      description: 'Monofs authentication token (auto-generated)',
      generateSecretString: { excludePunctuation: true, passwordLength: 32 },
    });
    this.monofsToken = monofsToken;
    this.monofsTokenSecret = monofsToken;

    // Shared bearer token for the Guardian access-policy endpoint. Doctor and
    // MonoFS use it to poll `/api/access/policy`; it is not a user credential.
    const guardianAccessPolicyToken = new secretsmanager.Secret(this, 'GuardianAccessPolicyToken', {
      secretName: 'strata/guardian/access-policy-token',
      description: 'Bearer token for Doctor/MonoFS access-policy polling',
      generateSecretString: { excludePunctuation: true, passwordLength: 48 },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.guardianAccessPolicyToken = guardianAccessPolicyToken;

    // ═══════════════════════════════════════════════════════════════
    // EFS
    // ═══════════════════════════════════════════════════════════════
    const filesystem = new efs.FileSystem(this, 'Efs', {
      vpc,
      securityGroup: efsSg,
      encrypted: true,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const serverAP = filesystem.addAccessPoint('ServerAP', {
      path: '/server',
      createAcl: { ownerUid: '0', ownerGid: '0', permissions: '755' },
    });

    const fetcherAP = filesystem.addAccessPoint('FetcherAP', {
      path: '/fetcher',
      createAcl: { ownerUid: '1000', ownerGid: '1000', permissions: '755' },
    });

    const searchAP = filesystem.addAccessPoint('SearchAP', {
      path: '/search',
      createAcl: { ownerUid: '1000', ownerGid: '1000', permissions: '755' },
    });

    // ═══════════════════════════════════════════════════════════════
    // S3
    // ═══════════════════════════════════════════════════════════════
    const blobBucket = new s3.Bucket(this, 'BlobBucket', {
      bucketName: `monofs-blobs-${accountId}-${region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          id: 'ExpireOldVersions',
          enabled: true,
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
      ],
    });

    // ═══════════════════════════════════════════════════════════════
    // IAM
    // ═══════════════════════════════════════════════════════════════
    const monofsExecRole = new iam.Role(this, 'MonofsExecRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });
    encryptionKey.grantRead(monofsExecRole);
    monofsToken.grantRead(monofsExecRole);

    const monofsTaskRole = new iam.Role(this, 'MonofsTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    blobBucket.grantReadWrite(monofsTaskRole);
    encryptionKey.grantRead(monofsTaskRole);
    monofsToken.grantRead(monofsTaskRole);

    const guardianExecRole = new iam.Role(this, 'GuardianExecRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });
    monofsToken.grantRead(guardianExecRole);
    guardianAccessPolicyToken.grantRead(guardianExecRole);

    // Explicit secret grants for every task execution role. `grantRead` uses the
    // secret ARN, but the ARN includes an auto-generated suffix; a wildcard
    // resource avoids any ARN/suffix mismatch when ECS pulls secrets.
    for (const execRole of [monofsExecRole, guardianExecRole]) {
      execRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
          resources: [
            `arn:aws:secretsmanager:${region}:${accountId}:secret:strata/monofs/encryption-key*`,
            `arn:aws:secretsmanager:${region}:${accountId}:secret:strata/monofs/token*`,
            `arn:aws:secretsmanager:${region}:${accountId}:secret:strata/guardian/access-policy-token*`,
            `arn:aws:secretsmanager:${region}:${accountId}:secret:strata/cognito/client-secret*`,
          ],
        }),
      );
    }

    // ═══════════════════════════════════════════════════════════════
    // CLOUDWATCH LOGS
    // ═══════════════════════════════════════════════════════════════
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: '/ecs/strata',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const logDriver = ecs.LogDrivers.awsLogs({ streamPrefix: 'strata', logGroup });

    // ═══════════════════════════════════════════════════════════════
    // ALB
    // ═══════════════════════════════════════════════════════════════
    const alb = new elb.ApplicationLoadBalancer(this, 'ALB', {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const listener = alb.addListener('HttpListener', {
      port: 80,
      defaultAction: elb.ListenerAction.fixedResponse(404, {
        messageBody: 'Not Found',
        contentType: 'text/plain',
      }),
    });
    this.alb = alb;
    this.albListener = listener;

    // ───────────────────────────────────────────────────────────
    // CloudFront (HTTPS front door). Cognito requires https
    // callback URLs, so SSO traffic flows via the *.cloudfront.net
    // distribution domain in front of the plain-HTTP ALB.
    // ───────────────────────────────────────────────────────────
    let distribution: cloudfront.Distribution | undefined;
    if (deploySSO) {
      distribution = new cloudfront.Distribution(this, 'EdgeDistribution', {
        comment: 'strata edge (HTTPS for Guardian + MonoFS OIDC)',
        priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
        defaultBehavior: {
          origin: new origins.HttpOrigin(alb.loadBalancerDnsName, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
            readTimeout: cdk.Duration.seconds(60),
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      });
    }

    const appBaseUrl = distribution
      ? `https://${distribution.distributionDomainName}`
      : `http://${alb.loadBalancerDnsName}`;

    // Doctor gets its own CloudFront distribution and a dedicated ALB listener
    // on :8080 so its root-relative UI/API paths do not collide with Guardian's
    // /* rule. The listener and target group are created by ObservabilityStack;
    // this distribution only needs the ALB DNS name, which avoids a
    // CloudFront -> Doctor-service -> task-definition dependency cycle.
    let doctorUrl: string | undefined;
    if (deploySSO && ctxBool('deployObservability', true)) {
      albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8080), 'HTTP from CloudFront to Doctor');
      const doctorDistribution = new cloudfront.Distribution(this, 'DoctorEdgeDistribution', {
        comment: 'strata doctor edge (HTTPS, Cognito OIDC)',
        priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
        defaultBehavior: {
          origin: new origins.HttpOrigin(alb.loadBalancerDnsName, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
            httpPort: 8080,
            readTimeout: cdk.Duration.seconds(60),
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      });
      doctorUrl = `https://${doctorDistribution.distributionDomainName}`;
      this.doctorUrl = doctorUrl;
    }

    // ═══════════════════════════════════════════════════════════════
    // COGNITO SSO (optional)
    // ═══════════════════════════════════════════════════════════════
    let userPool: cognito.UserPool | undefined;
    let userPoolClient: cognito.UserPoolClient | undefined;
    let cognitoDomain: cognito.UserPoolDomain | undefined;
    let cognitoClientSecret: secretsmanager.Secret | undefined;

    const demoPassword = 'StrataDemo1!';
    const demoGrants = JSON.stringify([
      { subject: 'admin@example.com', partition: '*', role: 'admin' },
      { subject: 'usera@example.com', partition: 'div-a-orders', role: 'admin' },
      { subject: 'usera@example.com', partition: 'div-a-billing', role: 'admin' },
      { subject: 'userb@example.com', partition: 'div-b-inventory', role: 'admin' },
    ]);

    if (deploySSO) {
      userPool = new cognito.UserPool(this, 'UserPool', {
        userPoolName: 'strata',
        selfSignUpEnabled: false,
        signInAliases: { username: true, email: true },
        autoVerify: { email: true },
        standardAttributes: {
          email: { required: true, mutable: true },
        },
        passwordPolicy: {
          minLength: 8,
          requireLowercase: true,
          requireDigits: true,
        },
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

      userPoolClient = userPool.addClient('AppClient', {
        userPoolClientName: 'strata-app',
        authFlows: { userPassword: true, userSrp: true },
        oAuth: {
          flows: { authorizationCodeGrant: true },
          scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
          callbackUrls: [
            `${appBaseUrl}/auth/callback`,
            `${appBaseUrl}/monofs/auth/callback`,
          ],
          logoutUrls: [
            `${appBaseUrl}/`,
            `${appBaseUrl}/monofs/`,
          ],
        },
        generateSecret: true,
        preventUserExistenceErrors: true,
      });

      cognitoDomain = userPool.addDomain('CognitoDomain', {
        cognitoDomain: { domainPrefix: `strata-${accountId}` },
      });

      cognitoClientSecret = new secretsmanager.Secret(this, 'CognitoClientSecret', {
        secretName: 'strata/cognito/client-secret',
        description: 'Cognito app client secret for OIDC',
        secretStringValue: userPoolClient.userPoolClientSecret,
      });

      cognitoClientSecret.grantRead(monofsExecRole);
      cognitoClientSecret.grantRead(guardianExecRole);

      // Demo identities matching the k8s demo. Cognito has no L2 user helper
      // with a permanent password, so create the user and set the password via
      // an AwsCustomResource.
      const demoUsers = [
        { username: 'usera', email: 'usera@example.com' },
        { username: 'userb', email: 'userb@example.com' },
        { username: 'akadmin', email: 'admin@example.com' },
      ];
      for (const entry of demoUsers) {
        const cfnUser = new cognito.CfnUserPoolUser(this, `DemoUser${entry.username}`, {
          userPoolId: userPool.userPoolId,
          username: entry.username,
          messageAction: 'SUPPRESS',
          userAttributes: [
            { name: 'email', value: entry.email },
            { name: 'email_verified', value: 'true' },
          ],
        });
        const setPassword = new customResources.AwsCustomResource(this, `DemoUserPassword${entry.username}`, {
          installLatestAwsSdk: false,
          onCreate: {
            service: 'CognitoIdentityServiceProvider',
            action: 'adminSetUserPassword',
            parameters: {
              UserPoolId: userPool.userPoolId,
              Username: entry.username,
              Password: demoPassword,
              Permanent: true,
            },
            physicalResourceId: customResources.PhysicalResourceId.of(`demo-password-${entry.username}`),
          },
          onUpdate: {
            service: 'CognitoIdentityServiceProvider',
            action: 'adminSetUserPassword',
            parameters: {
              UserPoolId: userPool.userPoolId,
              Username: entry.username,
              Password: demoPassword,
              Permanent: true,
            },
            physicalResourceId: customResources.PhysicalResourceId.of(`demo-password-${entry.username}`),
          },
          policy: customResources.AwsCustomResourcePolicy.fromSdkCalls({
            resources: [userPool.userPoolArn],
          }),
        });
        setPassword.node.addDependency(cfnUser);
      }

      this.userPool = userPool;
      this.userPoolClient = userPoolClient;
      this.cognitoDomain = cognitoDomain;
    }

    // ═══════════════════════════════════════════════════════════════
    // DOCKER IMAGE ASSETS  (build context = repo root)
    // ═══════════════════════════════════════════════════════════════
    const docker = (file: string) => dockerImage(file);

    const monofsServerImage = docker('monofs-server.Dockerfile');
    const monofsRouterImage = docker('monofs-router.Dockerfile');
    const monofsFetcherImage = docker('monofs-fetcher.Dockerfile');
    const monofsRegistryImage = docker('monofs-registry.Dockerfile');
    const monofsSearchImage = docker('monofs-search.Dockerfile');
    const guardianImage = docker('guardiand.Dockerfile');

    // ───────────────────────────────────────────────────────────
    // Helper: ECS Service Connect DNS names for inter-service links
    // ───────────────────────────────────────────────────────────
    const svcDns = (svc: string): string => `${svc}`;
    // In Service Connect, containers resolve <dnsName> or <dnsName>.strata.local


    // ═══════════════════════════════════════════════════════════════
    // MONOFS SERVER  (internal — no ALB, reachable via Service Connect)
    // ═══════════════════════════════════════════════════════════════
    if (deployMonofsServer) {
      const taskDef = new ecs.FargateTaskDefinition(this, 'MonofsServerTask', {
        family: 'monofs-server',
        memoryLimitMiB: 2048,
        cpu: 1024,
        executionRole: monofsExecRole,
        taskRole: monofsTaskRole,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      });

      taskDef.addVolume({
        name: 'data',
        efsVolumeConfiguration: {
          fileSystemId: filesystem.fileSystemId,
          authorizationConfig: { accessPointId: serverAP.accessPointId },
          transitEncryption: 'ENABLED',
        },
      });

      const nodeCmd: string[] = [
        '--addr=:9000',
        '--metrics-addr=:9100',
        '--node-id=node-a',
        '--db-path=/data/db',
        '--logengine-dir=/data/logengine',
        '--git-cache=/data/git',
        '--kvs-data-dir=/data/kvs',
        '--kvs-api-addr=monofs-server:9000',
        '--kvs-raft-addr=0.0.0.0:7000',
        '--kvs-raft-advertise-addr=monofs-server:7000',
        ...(serverCount === 1 ? ['--kvs-bootstrap'] : []),
        '--enable-prediction',
        '--db-sync=true',
        '--log-level=warn',
      ];

      if (deployMonofsFetcher) {
        nodeCmd.push('--fetcher=monofs-fetcher:9200');
      }

      const container = taskDef.addContainer('monofs-server', {
        image: monofsServerImage,
        logging: logDriver,
        command: nodeCmd,
        environment: {
          MONOFS_S3_BUCKET: blobBucket.bucketName,
          MONOFS_S3_REGION: region,
          MONOFS_OTEL_SERVICE_NAME: 'monofs.monofs-storage.monofs-server',
          OTEL_SERVICE_NAME: 'monofs.monofs-storage.monofs-server',
          OTEL_RESOURCE_ATTRIBUTES: 'service.alias=monofs-server,guardian.partition=monofs,guardian.intent=monofs-storage,guardian.asset=monofs-server,guardian.asset.type=Compute,guardian.identity.kind=platform',
          MONOFS_OTEL_INSECURE: 'true',
          MONOFS_OTEL_METRIC_INTERVAL: '30s',
        },
        secrets: {
          MONOFS_ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(encryptionKey),
        },
      });

      container.addPortMappings(
        { name: 'grpc', containerPort: 9000, protocol: ecs.Protocol.TCP },
        { name: 'raft', containerPort: 7000, protocol: ecs.Protocol.TCP },
        { name: 'diagnostics', containerPort: 9100, protocol: ecs.Protocol.TCP },
      );

      container.addMountPoints({ sourceVolume: 'data', containerPath: '/data', readOnly: false });

      const serverSvc = new ecs.FargateService(this, 'MonofsServerSvc', {
        cluster,
        taskDefinition: taskDef,
        desiredCount: serverCount,
        securityGroups: [monofsSg],
        vpcSubnets: privateSubnets,
        assignPublicIp: false,
        serviceConnectConfiguration: {
          namespace: cloudMapNs.namespaceName,
          services: [
            { portMappingName: 'grpc', dnsName: 'monofs-server', port: 9000, discoveryName: 'monofs-server' },
            { portMappingName: 'raft', dnsName: 'monofs-server-raft', port: 7000, discoveryName: 'monofs-server-raft' },
          ],
        },
        minHealthyPercent: 0,
        maxHealthyPercent: 200,
        circuitBreaker: { rollback: true },
      });
      serverSvc.node.addDependency(cloudMapNs);
      this.monofsServerSvc = serverSvc;
    }

    // ═══════════════════════════════════════════════════════════════
    // MONOFS FETCHER  (internal)
    // ═══════════════════════════════════════════════════════════════
    if (deployMonofsFetcher) {
      const taskDef = new ecs.FargateTaskDefinition(this, 'MonofsFetcherTask', {
        family: 'monofs-fetcher',
        memoryLimitMiB: 1024,
        cpu: 512,
        executionRole: monofsExecRole,
        taskRole: monofsTaskRole,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      });

      taskDef.addVolume({
        name: 'cache',
        efsVolumeConfiguration: {
          fileSystemId: filesystem.fileSystemId,
          authorizationConfig: { accessPointId: fetcherAP.accessPointId },
          transitEncryption: 'ENABLED',
        },
      });

      const container = taskDef.addContainer('monofs-fetcher', {
        image: monofsFetcherImage,
        logging: logDriver,
        environment: {
          MONOFS_S3_BUCKET: blobBucket.bucketName,
          MONOFS_S3_REGION: region,
        },
        secrets: {
          MONOFS_ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(encryptionKey),
        },
      });

      container.addPortMappings(
        { name: 'grpc', containerPort: 9200, protocol: ecs.Protocol.TCP },
        { name: 'diagnostics', containerPort: 9201, protocol: ecs.Protocol.TCP },
      );

      container.addMountPoints({ sourceVolume: 'cache', containerPath: '/data/cache', readOnly: false });

      const fetcherSvc = new ecs.FargateService(this, 'MonofsFetcherSvc', {
        cluster,
        taskDefinition: taskDef,
        desiredCount: fetcherCount,
        securityGroups: [monofsSg],
        vpcSubnets: privateSubnets,
        assignPublicIp: false,
        serviceConnectConfiguration: {
          namespace: cloudMapNs.namespaceName,
          services: [{ portMappingName: 'grpc', dnsName: 'monofs-fetcher', port: 9200, discoveryName: 'monofs-fetcher' }],
        },
        minHealthyPercent: 100,
        maxHealthyPercent: 200,
        circuitBreaker: { rollback: true },
      });
      fetcherSvc.node.addDependency(cloudMapNs);
    }

    // ═══════════════════════════════════════════════════════════════
    // MONOFS REGISTRY  (internal)
    // ═══════════════════════════════════════════════════════════════
    if (deployMonofsRegistry) {
      const taskDef = new ecs.FargateTaskDefinition(this, 'MonofsRegistryTask', {
        family: 'monofs-registry',
        memoryLimitMiB: 512,
        cpu: 256,
        executionRole: monofsExecRole,
        taskRole: monofsTaskRole,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      });

      const container = taskDef.addContainer('monofs-registry', {
        image: monofsRegistryImage,
        logging: logDriver,
        environment: {
          MONOFS_S3_BUCKET: blobBucket.bucketName,
          MONOFS_S3_REGION: region,
        },
        secrets: {
          MONOFS_TOKEN: ecs.Secret.fromSecretsManager(monofsToken),
          MONOFS_ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(encryptionKey),
        },
      });

      container.addPortMappings({ name: 'registry', containerPort: 5000, protocol: ecs.Protocol.TCP });

      const registrySvc = new ecs.FargateService(this, 'MonofsRegistrySvc', {
        cluster,
        taskDefinition: taskDef,
        desiredCount: 1,
        securityGroups: [monofsSg],
        vpcSubnets: privateSubnets,
        assignPublicIp: false,
        serviceConnectConfiguration: {
          namespace: cloudMapNs.namespaceName,
          services: [{ portMappingName: 'registry', dnsName: 'monofs-registry', port: 5000, discoveryName: 'monofs-registry' }],
        },
      });
      registrySvc.node.addDependency(cloudMapNs);
    }

    // ═══════════════════════════════════════════════════════════════
    // MONOFS SEARCH  (internal)
    // ═══════════════════════════════════════════════════════════════
    if (deployMonofsSearch) {
      const taskDef = new ecs.FargateTaskDefinition(this, 'MonofsSearchTask', {
        family: 'monofs-search',
        memoryLimitMiB: 2048,
        cpu: 1024,
        executionRole: monofsExecRole,
        taskRole: monofsTaskRole,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      });

      taskDef.addVolume({
        name: 'indexes',
        efsVolumeConfiguration: {
          fileSystemId: filesystem.fileSystemId,
          authorizationConfig: { accessPointId: searchAP.accessPointId },
          transitEncryption: 'ENABLED',
        },
      });

      const container = taskDef.addContainer('monofs-search', {
        image: monofsSearchImage,
        logging: logDriver,
        secrets: {
          MONOFS_ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(encryptionKey),
        },
      });

      container.addPortMappings(
        { name: 'grpc', containerPort: 9100, protocol: ecs.Protocol.TCP },
        { name: 'diagnostics', containerPort: 9101, protocol: ecs.Protocol.TCP },
      );

      container.addMountPoints({ sourceVolume: 'indexes', containerPath: '/data/indexes', readOnly: false });

      const searchSvc = new ecs.FargateService(this, 'MonofsSearchSvc', {
        cluster,
        taskDefinition: taskDef,
        desiredCount: 1,
        securityGroups: [monofsSg],
        vpcSubnets: privateSubnets,
        assignPublicIp: false,
        serviceConnectConfiguration: {
          namespace: cloudMapNs.namespaceName,
          services: [{ portMappingName: 'grpc', dnsName: 'monofs-search', port: 9100, discoveryName: 'monofs-search' }],
        },
      });
      searchSvc.node.addDependency(cloudMapNs);
    }

    // ═══════════════════════════════════════════════════════════════
    // MONOFS ROUTER  (ALB-exposed HTTP, internal gRPC)
    // ═══════════════════════════════════════════════════════════════
    if (deployMonofsRouter) {
      // Public NLB for guardianctl / pusher gRPC access from outside the VPC.
      // The MonoFS token is still required on every RPC.
      const routerNlb = new elb.NetworkLoadBalancer(this, 'MonofsRouterNlb', {
        vpc,
        internetFacing: true,
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      });

      const taskDef = new ecs.FargateTaskDefinition(this, 'MonofsRouterTask', {
        family: 'monofs-router',
        memoryLimitMiB: 1024,
        cpu: 512,
        executionRole: monofsExecRole,
        taskRole: monofsTaskRole,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      });

      const parts: string[] = ['--port=9090', '--http-port=8080', '--cluster-id=strata-cluster'];

      if (deployMonofsServer) {
        parts.push(`--nodes=node-a=${svcDns('monofs-server')}:9000`);

        // Out-of-VPC clients (guardianctl, local pushers) dial MonoFS nodes
        // directly, so advertise the public NLB address for the single-node
        // demo cluster. Multi-node clusters need per-node endpoints.
        if (serverCount === 1) {
          parts.push(`--external-addrs=node-a=${routerNlb.loadBalancerDnsName}:9000`);
        }

        if (serverCount > 1) {
          parts.push(`--server-diagnostics-addrs=${svcDns('monofs-server')}:9100`);
        }
      }

      if (deployMonofsFetcher) {
        parts.push(`--fetcher-addrs=${svcDns('monofs-fetcher')}:9200`);
      }

      if (deployMonofsSearch) {
        parts.push(`--search-addr=${svcDns('monofs-search')}:9100`);
      }

      if (deployMonofsRegistry) {
        parts.push(`--registry-addr=${svcDns('monofs-registry')}:5000`);
      }

      parts.push('--log-level=warn');

      const routerEnv: Record<string, string> = {};
      const routerSecrets: Record<string, ecs.Secret> = {
        MONOFS_ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(encryptionKey),
        MONOFS_TOKEN: ecs.Secret.fromSecretsManager(monofsToken),
      };

      if (deploySSO && userPool && userPoolClient && cognitoDomain && cognitoClientSecret) {
        const cognitoIssuer = `https://cognito-idp.${region}.amazonaws.com/${userPool.userPoolId}`;
        const cognitoAuthzUrl = `https://${cognitoDomain.domainName}.auth.${region}.amazoncognito.com/oauth2/authorize`;

        // The router reads the issuer/audience from flags (not env).
        parts.push(`--oidc-issuer=${cognitoIssuer}`);
        parts.push(`--oidc-audience=${userPoolClient.userPoolClientId}`);

        routerEnv.MONOFS_OIDC_ISSUER = cognitoIssuer;
        routerEnv.MONOFS_OIDC_AUDIENCE = userPoolClient.userPoolClientId;
        routerEnv.MONOFS_OIDC_CLIENT_ID = userPoolClient.userPoolClientId;
        routerEnv.MONOFS_OIDC_SCOPES = 'openid email profile';
        routerEnv.MONOFS_OIDC_REDIRECT_URL = `${appBaseUrl}/monofs/auth/callback`;
        routerEnv.MONOFS_ROUTER_OIDC_REDIRECT_URL = `${appBaseUrl}/monofs/auth/callback`;
        routerEnv.MONOFS_OIDC_AUTH_URL = cognitoAuthzUrl;
        routerEnv.MONOFS_ROUTER_OIDC_AUTH_URL = cognitoAuthzUrl;
        routerEnv.MONOFS_AUTHZ_ENFORCE_INGEST = 'true';
        routerEnv.MONOFS_AUTHZ_ENFORCE_UI = 'true';
        routerEnv.MONOFS_AUTHZ_GRANTS_JSON = demoGrants;
        // MonoFS read-path policy enforcement is intentionally not enabled in
        // this MVP: the local/Docker onboarding and repo-ingest principals are
        // not yet represented in the compiled policy. Guardian/MonoFS
        // ingest/UI grants and Doctor log/trace filtering cover the demo.
        routerSecrets.MONOFS_OIDC_CLIENT_SECRET = ecs.Secret.fromSecretsManager(cognitoClientSecret);
      }

      const container = taskDef.addContainer('monofs-router', {
        image: monofsRouterImage,
        logging: logDriver,
        command: parts,
        environment: routerEnv,
        secrets: routerSecrets,
      });

      container.addPortMappings(
        { name: 'grpc', containerPort: 9090, protocol: ecs.Protocol.TCP },
        { name: 'http', containerPort: 8080, protocol: ecs.Protocol.TCP },
      );

      const svc = new ecs.FargateService(this, 'MonofsRouterSvc', {
        cluster,
        taskDefinition: taskDef,
        desiredCount: routerCount,
        securityGroups: [monofsSg],
        vpcSubnets: privateSubnets,
        assignPublicIp: false,
        serviceConnectConfiguration: {
          namespace: cloudMapNs.namespaceName,
          services: [
            { portMappingName: 'grpc', dnsName: 'monofs-router', port: 9090, discoveryName: 'monofs-router' },
            { portMappingName: 'http', dnsName: 'monofs-router-http', port: 8080, discoveryName: 'monofs-router-http' },
          ],
        },
        minHealthyPercent: 100,
        maxHealthyPercent: 200,
        circuitBreaker: { rollback: true },
      });
      svc.node.addDependency(cloudMapNs);
      this.monofsRouterSvc = svc;

      routerNlb
        .addListener('Grpc', { port: 9090 })
        .addTargets('Router', {
          port: 9090,
          targets: [svc.loadBalancerTarget({ containerName: 'monofs-router', containerPort: 9090 })],
        });
      monofsSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(9090), 'Public MonoFS router gRPC (token auth)');
      this.monofsRouterNlbDns = routerNlb.loadBalancerDnsName;

      if (this.monofsServerSvc) {
        routerNlb
          .addListener('ServerGrpc', { port: 9000 })
          .addTargets('Server', {
            port: 9000,
            targets: [this.monofsServerSvc.loadBalancerTarget({ containerName: 'monofs-server', containerPort: 9000 })],
          });
        monofsSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(9000), 'Public MonoFS server gRPC (token auth)');
      }

      listener.addTargets('MonofsRouterTarget', {
        port: 8080,
        protocol: elb.ApplicationProtocol.HTTP,
        priority: 10,
        conditions: [elb.ListenerCondition.pathPatterns(['/monofs', '/monofs/*'])],
        healthCheck: {
          path: '/', port: '8080', interval: cdk.Duration.seconds(30),
          healthyHttpCodes: '200-499',
        },
        targets: [svc.loadBalancerTarget({ containerName: 'monofs-router', containerPort: 8080 })],
      });
    }

    // ═══════════════════════════════════════════════════════════════
    // GUARDIAN  (ALB-exposed HTTP)
    // ═══════════════════════════════════════════════════════════════
    if (deployGuardian) {
      const taskDef = new ecs.FargateTaskDefinition(this, 'GuardiandTask', {
        family: 'guardiand',
        memoryLimitMiB: 1024,
        cpu: 512,
        executionRole: guardianExecRole,
        taskRole: monofsTaskRole,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      });

      const guardianEnv: Record<string, string> = {
        GUARDIAN_MONOFS_ROUTER: deployMonofsRouter ? `${svcDns('monofs-router')}:9090` : 'localhost:9090',
        GUARDIAN_MONOFS_USE_EXTERNAL_ADDRESSES: 'false',
        GUARDIAN_MONOFS_CLIENT_USE_EXTERNAL_ADDRESSES: 'false',
        GUARDIAN_UI_LISTEN: ':8090',
        GUARDIAN_UI_BASE_URL: '/',
        GUARDIAN_RECONCILE_INTERVAL: '1m',
        GUARDIAN_PUSHERS: `local:/.queues/local,aws-${accountId}:/.queues/aws-${accountId}`,
        GUARDIAN_ACCESS_POLICY_PATH: '/.access/envs/dev.yaml',
        GUARDIAN_ACCESS_ENFORCE: 'true',
      };
      const guardianSecrets: Record<string, ecs.Secret> = {
        GUARDIAN_MONOFS_TOKEN: ecs.Secret.fromSecretsManager(monofsToken),
        GUARDIAN_CLIENT_DISCOVERY_TOKEN: ecs.Secret.fromSecretsManager(monofsToken),
        GUARDIAN_ACCESS_POLICY_TOKEN: ecs.Secret.fromSecretsManager(guardianAccessPolicyToken),
      };

      if (deploySSO && userPool && userPoolClient && cognitoDomain && cognitoClientSecret) {
        const cognitoIssuer = `https://cognito-idp.${region}.amazonaws.com/${userPool.userPoolId}`;
        const cognitoAuthzUrl = `https://${cognitoDomain.domainName}.auth.${region}.amazoncognito.com/oauth2/authorize`;

        guardianEnv.MONOFS_OIDC_ISSUER = cognitoIssuer;
        guardianEnv.MONOFS_OIDC_AUDIENCE = userPoolClient.userPoolClientId;
        guardianEnv.MONOFS_OIDC_CLIENT_ID = userPoolClient.userPoolClientId;
        guardianEnv.MONOFS_OIDC_SCOPES = 'openid email profile';
        guardianEnv.MONOFS_OIDC_REDIRECT_URL = `${appBaseUrl}/auth/callback`;
        guardianEnv.MONOFS_OIDC_AUTH_URL = cognitoAuthzUrl;
        guardianEnv.GUARDIAN_AUTHZ_ENFORCE_DEPLOY = 'true';
        guardianEnv.MONOFS_AUTHZ_ENFORCE_UI = 'true';
        guardianEnv.MONOFS_AUTHZ_GRANTS_JSON = demoGrants;
        guardianSecrets.MONOFS_OIDC_CLIENT_SECRET = ecs.Secret.fromSecretsManager(cognitoClientSecret);
      }

      const container = taskDef.addContainer('guardiand', {
        image: guardianImage,
        logging: logDriver,
        environment: guardianEnv,
        secrets: guardianSecrets,
      });

      container.addPortMappings({ name: 'http', containerPort: 8090, protocol: ecs.Protocol.TCP });

      const svc = new ecs.FargateService(this, 'GuardiandSvc', {
        cluster,
        taskDefinition: taskDef,
        desiredCount: guardianCount,
        securityGroups: [guardianSg],
        vpcSubnets: privateSubnets,
        assignPublicIp: false,
        serviceConnectConfiguration: {
          namespace: cloudMapNs.namespaceName,
          services: [{ portMappingName: 'http', dnsName: 'guardiand', port: 8090, discoveryName: 'guardiand' }],
        },
        minHealthyPercent: 100,
        maxHealthyPercent: 200,
        circuitBreaker: { rollback: true },
      });
      svc.node.addDependency(cloudMapNs);
      if (this.monofsRouterSvc) {
        // Guardian's store client dials monofs-router:9090; wait for the
        // router's Service Connect registration so DNS resolves.
        svc.node.addDependency(this.monofsRouterSvc);
      }

      listener.addTargets('GuardianTarget', {
        port: 8090,
        protocol: elb.ApplicationProtocol.HTTP,
        priority: 20,
        conditions: [elb.ListenerCondition.pathPatterns(['/*'])],
        healthCheck: {
          path: '/', port: '8090', interval: cdk.Duration.seconds(30),
          healthyHttpCodes: '200-499',
        },
        targets: [svc.loadBalancerTarget({ containerName: 'guardiand', containerPort: 8090 })],
      });
    }

    // ───────────────────────────────────────────────────────────
    // Ordering guard: ECS cannot fetch task secrets until the
    // execution-role inline policy is attached. CloudFormation does not
    // add that dependency automatically, so Fargate can start tasks
    // before the policy exists and the deployment circuit breaker trips
    // with AccessDenied on secretsmanager:GetSecretValue.
    // ───────────────────────────────────────────────────────────
    const iamPolicyDeps = [
      monofsExecRole,
      monofsTaskRole,
      guardianExecRole,
    ]
      .map((role) => role.node.tryFindChild('DefaultPolicy'))
      .filter((child): child is Construct => child !== undefined);
    if (iamPolicyDeps.length > 0) {
      for (const child of this.node.findAll()) {
        if (child instanceof ecs.FargateService) {
          child.node.addDependency(...iamPolicyDeps);
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // OUTPUTS
    // ═══════════════════════════════════════════════════════════════
    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: alb.loadBalancerDnsName,
      description: 'ALB DNS — access Guardian UI at / and Monofs at /monofs/',
    });

    new cdk.CfnOutput(this, 'AppUrl', {
      value: appBaseUrl,
      description: 'Primary app URL (CloudFront HTTPS when SSO is enabled, else ALB HTTP)',
    });

    new cdk.CfnOutput(this, 'MonofsUrl', {
      value: `${appBaseUrl}/monofs/`,
      description: 'MonoFS UI and API',
    });

    new cdk.CfnOutput(this, 'MonofsTokenSecretArn', {
      value: monofsToken.secretArn,
      description: 'MonoFS guardian token secret for guardianctl/pushers',
    });

    new cdk.CfnOutput(this, 'GuardianAccessPolicyTokenSecretArn', {
      value: guardianAccessPolicyToken.secretArn,
      description: 'Bearer token for Doctor/MonoFS access-policy polling',
    });

    if (this.doctorUrl) {
      new cdk.CfnOutput(this, 'DoctorUrl', {
        value: this.doctorUrl,
        description: 'Public HTTPS Doctor UI/API (Cognito OIDC)',
      });
    }

    if (this.monofsRouterNlbDns) {
      new cdk.CfnOutput(this, 'MonofsRouterEndpoint', {
        value: `${this.monofsRouterNlbDns}:9090`,
        description: 'Public NLB gRPC endpoint for guardianctl --monofs-router',
      });
    }

    new cdk.CfnOutput(this, 'EcsClusterName', {
      value: cluster.clusterName,
      description: 'ECS cluster name',
    });

    new cdk.CfnOutput(this, 'BlobBucketName', {
      value: blobBucket.bucketName,
      description: 'S3 bucket for Monofs blob storage',
    });

    new cdk.CfnOutput(this, 'EfsFileSystemId', {
      value: filesystem.fileSystemId,
      description: 'EFS filesystem ID',
    });

    new cdk.CfnOutput(this, 'EncryptionKeySecretArn', {
      value: encryptionKey.secretArn,
      description: 'Set encryption key before first deploy — see secret description for command',
    });

    if (deploySSO && userPool && userPoolClient && cognitoDomain) {
      new cdk.CfnOutput(this, 'CognitoUserPoolId', {
        value: userPool.userPoolId,
        description: 'Cognito User Pool ID',
      });

      new cdk.CfnOutput(this, 'CognitoClientId', {
        value: userPoolClient.userPoolClientId,
        description: 'Cognito App Client ID',
      });

      const hostedUI = `https://${cognitoDomain.domainName}.auth.${region}.amazoncognito.com`;
      new cdk.CfnOutput(this, 'CognitoHostedUIUrl', {
        value: hostedUI,
        description: 'Cognito hosted UI base URL',
      });

      const appHost = cdk.Fn.select(1, cdk.Fn.split('://', appBaseUrl));
      new cdk.CfnOutput(this, 'CognitoLoginUrl', {
        value: cdk.Fn.join('', [
          hostedUI,
          '/login?client_id=',
          userPoolClient.userPoolClientId,
          '&response_type=code&scope=openid+email+profile&redirect_uri=https%3A%2F%2F',
          appHost,
          '%2Fauth%2Fcallback',
        ]),
        description: 'Cognito login URL for the demo users',
      });

      new cdk.CfnOutput(this, 'DemoUsers', {
        value: 'usera (usera@example.com), userb (userb@example.com), akadmin (admin@example.com)',
        description: 'Demo users: UserA=DivisionA, UserB=DivisionB, Admin=all',
      });

      new cdk.CfnOutput(this, 'DemoPassword', {
        value: demoPassword,
        description: 'Password for the demo Cognito users (MVP only)',
      });
    }
  }
}
