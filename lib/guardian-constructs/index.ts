import { createHash } from 'crypto';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * guardian-constructs maps Guardian asset properties onto CDK resources.
 *
 * The TypeScript source of this file is embedded into the Go
 * internal/cdkgen package (see `go generate` in guardian/internal/cdkgen) and
 * copied into every generated stack payload. Keep it dependency-free apart
 * from aws-cdk-lib/constructs.
 */

export interface AssetCall {
  properties: Record<string, any>;
  generated: Record<string, any>;
}

export interface GuardianStackProps extends cdk.StackProps {
  partition: string;
  intent: string;
}

interface VolumeHandle {
  fileSystem: efs.CfnFileSystem;
}

interface ComputeHandle {
  assetName: string;
  service: ecs.FargateService;
  taskDefinition: ecs.FargateTaskDefinition;
  container: ecs.ContainerDefinition;
  securityGroup: ec2.SecurityGroup;
  cluster: ecs.Cluster;
  containerName: string;
  port: number;
}

const OTEL_COLLECTOR_IMAGE = 'public.ecr.aws/aws-observability/aws-otel-collector:v0.50.0';

export class GuardianStack extends cdk.Stack {
  public readonly guardianPartition: string;
  public readonly guardianIntent: string;

  private vpc?: ec2.Vpc;
  private serviceConnectNamespace?: servicediscovery.PrivateDnsNamespace;
  private readonly clusters = new Map<string, ecs.Cluster>();
  private readonly volumes = new Map<string, VolumeHandle>();
  private readonly computes = new Map<string, ComputeHandle>();

  constructor(scope: Construct, id: string, props: GuardianStackProps) {
    super(scope, id, props);
    this.guardianPartition = props.partition;
    this.guardianIntent = props.intent;
  }

  public addNetwork(name: string, call: AssetCall): void {
    if (this.vpc) {
      throw new Error(`Network asset ${name} must be declared before other assets`);
    }
    const id = constructId(name);
    this.vpc = new ec2.Vpc(this, `Vpc${id}`, {
      vpcName: call.generated.vpcName,
      ipAddresses: ec2.IpAddresses.cidr(String(call.properties.cidr || '10.0.0.0/16')),
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
    });
    this.exportOutput(name, 'vpcId', this.vpc.vpcId);
    this.exportOutput(name, 'cidr', String(call.properties.cidr || '10.0.0.0/16'));
    this.exportOutput(name, 'name', call.generated.vpcName);
  }

  public addVolume(name: string, call: AssetCall): void {
    const id = constructId(name);
    const vpc = this.ensureVpc();
    const fileSystem = new efs.CfnFileSystem(this, `Efs${id}`, {
      encrypted: true,
      fileSystemTags: [
        { key: 'Name', value: call.generated.fileSystemName },
        { key: 'guardian-asset', value: name },
      ],
    });
    const mountSg = new ec2.SecurityGroup(this, `EfsSg${id}`, {
      vpc,
      allowAllOutbound: false,
      description: `Guardian EFS mount targets for ${name}`,
    });
    mountSg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(2049));
    vpc.publicSubnets.forEach((subnet, index) => {
      new efs.CfnMountTarget(this, `EfsMt${id}${index}`, {
        fileSystemId: fileSystem.ref,
        subnetId: subnet.subnetId,
        securityGroups: [mountSg.securityGroupId],
      });
    });
    this.volumes.set(name, { fileSystem });
    this.exportOutput(name, 'efsId', fileSystem.ref);
    this.exportOutput(name, 'type', 'efs');
  }

  public addObjectStore(name: string, call: AssetCall): void {
    const id = constructId(name);
    const versioned = boolValue(call.properties.versioning);
    new s3.Bucket(this, `Bucket${id}`, {
      bucketName: call.generated.bucketName,
      versioned,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const region = String(call.properties.region || this.region);
    this.exportOutput(name, 'bucket', call.generated.bucketName);
    this.exportOutput(name, 'region', region);
    this.exportOutput(name, 'type', 's3');
  }

  public addCompute(name: string, call: AssetCall): void {
    const props = call.properties;
    const generated = call.generated;
    const id = constructId(name);
    if (boolValue(props.privileged) || boolValue(props.observeExisting)) {
      throw new Error(`compute asset ${name}: privileged/observeExisting is not supported by generated stacks`);
    }
    const vpc = this.ensureVpc();
    const clusterName = String(generated.cluster);
    let cluster = this.clusters.get(clusterName);
    if (!cluster) {
      cluster = new ecs.Cluster(this, `Cluster${constructId(clusterName)}`, {
        vpc,
        clusterName,
      });
      this.clusters.set(clusterName, cluster);
    }
    const securityGroup = new ec2.SecurityGroup(this, `Sg${id}`, {
      vpc,
      allowAllOutbound: true,
      description: `Guardian compute ${name}`,
    });
    securityGroup.addIngressRule(securityGroup, ec2.Port.allTraffic(), 'self');

    const logGroup = new logs.LogGroup(this, `Logs${id}`, {
      logGroupName: generated.logGroup,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const resources = resolveResources(props.resources);
    const taskDefinition = new ecs.FargateTaskDefinition(this, `Task${id}`, {
      family: generated.taskFamily,
      cpu: resources.cpu,
      memoryLimitMiB: resources.memory,
    });

    const executionRole = taskDefinition.obtainExecutionRole();
    executionRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));
    executionRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'ecr:BatchCheckLayerAvailability',
        'ecr:BatchGetImage',
        'ecr:GetDownloadUrlForLayer',
      ],
      resources: ['*'],
    }));

    const containerName = name;
    const container = taskDefinition.addContainer(`Container${id}`, {
      containerName,
      image: ecs.ContainerImage.fromRegistry(String(props.image)),
      command: stringList(props.command),
      environment: buildEnvironment(props.env, this.guardianPartition, this.guardianIntent, name, this.account, this.region),
      secrets: buildSecrets(this, name, generated.configParams),
      portMappings: buildPortMappings(props.ports),
      healthCheck: buildHealthCheck(props.healthCheck),
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: name }),
      essential: true,
    });

    const addedVolumes = new Set<string>();
    for (const mount of objectList(props.volumeMounts)) {
      const volumeName = String(mount.volume || '');
      const handle = this.volumes.get(volumeName);
      if (!handle) {
        throw new Error(`compute asset ${name}: volume ${volumeName} was not generated before it`);
      }
      const sourceVolume = `efs-${volumeName}`;
      if (!addedVolumes.has(sourceVolume)) {
        taskDefinition.addVolume({
          name: sourceVolume,
          efsVolumeConfiguration: {
            fileSystemId: handle.fileSystem.ref,
            transitEncryption: 'ENABLED',
          },
        });
        addedVolumes.add(sourceVolume);
      }
      container.addMountPoints({
        containerPath: String(mount.path || ''),
        sourceVolume,
        readOnly: boolValue(mount.readOnly),
      });
      taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: [
          'elasticfilesystem:ClientMount',
          'elasticfilesystem:ClientWrite',
          'elasticfilesystem:ClientRootAccess',
          'elasticfilesystem:DescribeMountTargets',
        ],
        resources: [handle.fileSystem.attrArn],
      }));
    }

    const service = new ecs.FargateService(this, `Service${id}`, {
      cluster,
      taskDefinition,
      serviceName: generated.serviceName,
      desiredCount: Number(props.replicas ?? 1),
      assignPublicIp: true,
      securityGroups: [securityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      circuitBreaker: { rollback: true },
    });

    this.computes.set(name, {
      assetName: name,
      service,
      taskDefinition,
      container,
      securityGroup,
      cluster,
      containerName,
      port: firstPort(props.ports),
    });
    this.exportOutput(name, 'service', service.serviceName);
    this.exportOutput(name, 'launchType', 'FARGATE');
    this.exportOutput(name, 'cluster', cluster.clusterName);
  }

  public addLoadBalancer(name: string, call: AssetCall): void {
    const props = call.properties;
    const generated = call.generated;
    const id = constructId(name);
    const vpc = this.ensureVpc();
    const targets: ComputeHandle[] = [];
    for (const targetName of stringList(props.targets)) {
      const handle = this.computes.get(targetName);
      if (!handle) {
        throw new Error(`load balancer ${name}: target compute ${targetName} was not generated before it`);
      }
      targets.push(handle);
    }
    const listeners = objectList(props.listeners);
    const tcp = listeners.some((listener) => String(listener.protocol || '').toLowerCase() === 'tcp');
    const internetFacing = props.serviceType !== 'ClusterIP';
    const tgNames = Array.isArray(generated.tgNames) ? generated.tgNames : [];

    if (tcp) {
      const lb = new elbv2.NetworkLoadBalancer(this, `Lb${id}`, {
        vpc,
        internetFacing,
        loadBalancerName: generated.lbName,
      });
      listeners.forEach((listener, index) => {
        const backendPort = targets[0]?.port || Number(listener.port || 80);
        const targetGroup = new elbv2.NetworkTargetGroup(this, `Tg${id}${index}`, {
          vpc,
          port: backendPort,
          protocol: elbv2.Protocol.TCP,
          targetType: elbv2.TargetType.IP,
          targetGroupName: tgNames[index],
        });
        for (const target of targets) {
          targetGroup.addTarget(target.service.loadBalancerTarget({
            containerName: target.containerName,
            containerPort: target.port,
          }));
        }
        lb.addListener(`L${id}${index}`, { port: Number(listener.port || 80) }).addTargetGroups(
          `Ltg${id}${index}`,
          targetGroup,
        );
        this.exportOutput(name, `tg_${index}_arn`, targetGroup.targetGroupArn);
      });
      this.exportOutput(name, 'lb_arn', lb.loadBalancerArn);
      this.exportOutput(name, 'lb_name', lb.loadBalancerName);
      this.exportOutput(name, 'dns_name', lb.loadBalancerDnsName);
      return;
    }

    const lb = new elbv2.ApplicationLoadBalancer(this, `Lb${id}`, {
      vpc,
      internetFacing,
      loadBalancerName: generated.lbName,
    });
    listeners.forEach((listener, index) => {
      const listenerPort = Number(listener.port || 80);
      const backendPort = targets[0]?.port || listenerPort;
      const targetGroup = new elbv2.ApplicationTargetGroup(this, `Tg${id}${index}`, {
        vpc,
        port: backendPort,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targetType: elbv2.TargetType.IP,
        targetGroupName: tgNames[index],
        deregistrationDelay: cdk.Duration.seconds(30),
      });
      for (const target of targets) {
        targetGroup.addTarget(target.service.loadBalancerTarget({
          containerName: target.containerName,
          containerPort: target.port,
        }));
        target.securityGroup.addIngressRule(
          lb.connections.securityGroups[0],
          ec2.Port.tcp(target.port),
          `load balancer ${name}`,
        );
      }
      lb.addListener(`L${id}${index}`, { port: listenerPort }).addTargetGroups(`Ltg${id}${index}`, {
        targetGroups: [targetGroup],
      });
      this.exportOutput(name, `tg_${index}_arn`, targetGroup.targetGroupArn);
    });
    this.exportOutput(name, 'lb_arn', lb.loadBalancerArn);
    this.exportOutput(name, 'lb_name', lb.loadBalancerName);
    this.exportOutput(name, 'dns_name', lb.loadBalancerDnsName);
  }

  public addDatabase(name: string, call: AssetCall): void {
    const props = call.properties;
    const generated = call.generated;
    const id = constructId(name);
    const vpc = this.ensureVpc();
    const engineName = String(props.engine || '').toLowerCase();
    const postgres = engineName === 'aurora-postgresql' || engineName === 'postgres' || engineName === 'postgresql' || engineName === 'aurora';
    const engine = postgres
      ? rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_15_4 })
      : rds.DatabaseClusterEngine.auroraMysql({ version: rds.AuroraMysqlEngineVersion.VER_3_06_0 });
    const port = Number(props.port ?? (postgres ? 5432 : 3306));
    const securityGroup = new ec2.SecurityGroup(this, `DbSg${id}`, {
      vpc,
      allowAllOutbound: true,
      description: `Guardian database ${name}`,
    });
    const database = sanitizeDatabaseName(String(props.database || name));
    const user = String(props.user || 'guardian');
    const writer = rds.ClusterInstance.serverlessV2('writer');
    const cluster = new rds.DatabaseCluster(this, `Db${id}`, {
      engine,
      clusterIdentifier: generated.clusterName,
      credentials: rds.Credentials.fromGeneratedSecret(user),
      defaultDatabaseName: database,
      writer,
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 2,
      port,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [securityGroup],
      storageEncrypted: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.exportOutput(name, 'id', cluster.clusterIdentifier);
    this.exportOutput(name, 'engine', postgres ? 'aurora-postgresql' : 'aurora-mysql');
    this.exportOutput(name, 'database', database);
    this.exportOutput(name, 'user', user);
    this.exportOutput(name, 'port', String(port));
    this.exportOutput(name, 'arn', cluster.clusterArn);
    this.exportOutput(name, 'endpoint', cluster.clusterEndpoint.hostname);
    this.exportOutput(name, 'readerEndpoint', cluster.clusterReadEndpoint.hostname);
    this.exportOutput(name, 'url', `${postgres ? 'postgresql' : 'mysql'}://${user}@${cluster.clusterEndpoint.hostname}:${port}/${database}`);
    if (cluster.secret) {
      this.exportOutput(name, 'secretArn', cluster.secret.secretArn);
    }
  }

  public addObservability(name: string, call: AssetCall): void {
    const props = call.properties;
    const generated = call.generated;
    const id = constructId(name);
    if (props.config) {
      throw new Error(`observability asset ${name}: Config-backed collector config is not supported by generated stacks yet`);
    }
    const targets: ComputeHandle[] = [];
    for (const targetName of stringList(props.targets)) {
      const handle = this.computes.get(targetName);
      if (!handle) {
        throw new Error(`observability ${name}: target compute ${targetName} was not generated before it`);
      }
      targets.push(handle);
    }
    const mode = String(props.mode || '').toLowerCase();
    if (mode === 'gateway' || mode === 'auto' || mode === 'collector') {
      this.addObservabilityGateway(name, call, targets);
      return;
    }
    const config = renderOtelConfig(name, props, generated, this.region);
    for (const target of targets) {
      const logGroup = new logs.LogGroup(this, `OtelLogs${id}${constructId(target.assetName)}`, {
        logGroupName: generated.logGroup,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      target.taskDefinition.addContainer(`Otel${id}${constructId(target.assetName)}`, {
        containerName: 'otel-collector',
        image: ecs.ContainerImage.fromRegistry(OTEL_COLLECTOR_IMAGE),
        command: ['--config=env:AOT_CONFIG_CONTENT'],
        environment: {
          AOT_CONFIG_CONTENT: config,
          AWS_REGION: this.region,
        },
        essential: false,
        logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'otel' }),
      });
      target.container.addEnvironment('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://localhost:4317');
      target.container.addEnvironment('OTEL_EXPORTER_OTLP_PROTOCOL', 'grpc');
      target.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: [
          'cloudwatch:PutMetricData',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
          'xray:PutTraceSegments',
          'xray:PutTelemetryRecords',
        ],
        resources: ['*'],
      }));
    }
    this.exportOutput(name, 'endpoint', 'http://localhost:4317');
    this.exportOutput(name, 'namespace', generated.namespace);
    this.exportOutput(name, 'logGroup', generated.logGroup);
  }

  private addObservabilityGateway(name: string, call: AssetCall, targets: ComputeHandle[]): void {
    if (targets.length === 0) {
      throw new Error(`observability ${name}: gateway mode requires at least one target compute asset`);
    }
    const props = call.properties;
    const generated = call.generated;
    const id = constructId(name);
    const cluster = targets[0].cluster;
    const vpc = cluster.vpc;
    const securityGroup = new ec2.SecurityGroup(this, `ObsGwSg${id}`, {
      vpc,
      allowAllOutbound: true,
      description: `Guardian observability gateway ${name}`,
    });
    securityGroup.addIngressRule(securityGroup, ec2.Port.allTraffic(), 'gateway self');
    for (const target of targets) {
      securityGroup.addIngressRule(target.securityGroup, ec2.Port.tcp(4317), 'otlp grpc');
      securityGroup.addIngressRule(target.securityGroup, ec2.Port.tcp(4318), 'otlp http');
    }
    const logGroup = new logs.LogGroup(this, `ObsGwLogs${id}`, {
      logGroupName: generated.logGroup,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const taskDefinition = new ecs.FargateTaskDefinition(this, `ObsGwTask${id}`, {
      cpu: 256,
      memoryLimitMiB: 512,
    });
    taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'cloudwatch:PutMetricData',
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'xray:PutTraceSegments',
        'xray:PutTelemetryRecords',
      ],
      resources: ['*'],
    }));
    const config = renderOtelConfig(name, props, generated, this.region);
    const container = taskDefinition.addContainer(`ObsGwContainer${id}`, {
      containerName: 'otel-collector',
      image: ecs.ContainerImage.fromRegistry(OTEL_COLLECTOR_IMAGE),
      command: ['--config=env:AOT_CONFIG_CONTENT'],
      environment: {
        AOT_CONFIG_CONTENT: config,
        AWS_REGION: this.region,
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'otel-gateway' }),
      essential: true,
    });
    container.addPortMappings(
      { containerPort: 4317, protocol: ecs.Protocol.TCP, name: 'otlp-grpc' },
      { containerPort: 4318, protocol: ecs.Protocol.TCP, name: 'otlp-http' },
    );
    const serviceConnectNamespace = this.ensureServiceConnectNamespace(vpc);
    const dnsName = `otel-${sanitizeDnsName(this.guardianPartition)}-${sanitizeDnsName(this.guardianIntent)}`;
    new ecs.FargateService(this, `ObsGwService${id}`, {
      cluster,
      taskDefinition,
      serviceName: `obs-gateway-${id}`.slice(0, 255),
      desiredCount: 1,
      assignPublicIp: true,
      securityGroups: [securityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      serviceConnectConfiguration: {
        namespace: serviceConnectNamespace.namespaceName,
        services: [{ portMappingName: 'otlp-grpc', dnsName, port: 4317 }],
      },
    });
    for (const target of targets) {
      target.container.addEnvironment('OTEL_EXPORTER_OTLP_ENDPOINT', `http://${dnsName}:4317`);
      target.container.addEnvironment('OTEL_EXPORTER_OTLP_PROTOCOL', 'grpc');
    }
    this.exportOutput(name, 'endpoint', `http://${dnsName}:4317`);
    this.exportOutput(name, 'namespace', generated.namespace);
    this.exportOutput(name, 'logGroup', generated.logGroup);
  }

  private ensureServiceConnectNamespace(vpc: ec2.IVpc): servicediscovery.PrivateDnsNamespace {
    if (!this.serviceConnectNamespace) {
      this.serviceConnectNamespace = new servicediscovery.PrivateDnsNamespace(this, 'GuardianServiceConnectNamespace', {
        name: 'guardian.local',
        vpc,
      });
    }
    return this.serviceConnectNamespace;
  }

  private ensureVpc(): ec2.Vpc {
    if (!this.vpc) {
      this.vpc = new ec2.Vpc(this, 'DefaultVpc', {
        maxAzs: 2,
        natGateways: 0,
        subnetConfiguration: [
          { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        ],
      });
    }
    return this.vpc;
  }

  private exportOutput(assetName: string, key: string, value: string): void {
    new cdk.CfnOutput(this, outputLogicalId(assetName, key), { value });
  }
}

export function outputLogicalId(assetName: string, key: string): string {
  return `Out${titleParts(assetName)}${titleParts(key)}`;
}

function titleParts(value: string): string {
  let out = '';
  let upperNext = true;
  for (const ch of value) {
    const isAlphaNum = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9');
    if (isAlphaNum) {
      out += upperNext && ch >= 'a' && ch <= 'z' ? ch.toUpperCase() : ch;
      upperNext = false;
    } else {
      upperNext = true;
    }
  }
  return out;
}

function sanitizeDnsName(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'observability';
}

function constructId(value: string): string {
  const parts = value.split(/[^A-Za-z0-9]+/).filter((part) => part.length > 0);
  return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('') || 'Asset';
}

function boolValue(value: any): boolean {
  return value === true || value === 'true';
}

function stringList(value: any): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => typeof item === 'string' && item.trim() !== '');
}

function objectList(value: any): Record<string, any>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => item && typeof item === 'object');
}

function firstPort(ports: any): number {
  for (const port of objectList(ports)) {
    if (port.containerPort) {
      return Number(port.containerPort);
    }
    if (port.port) {
      return Number(port.port);
    }
    if (port.servicePort) {
      return Number(port.servicePort);
    }
  }
  return 0;
}

function buildPortMappings(ports: any): ecs.PortMapping[] {
  const mappings: ecs.PortMapping[] = [];
  objectList(ports).forEach((port, index) => {
    const containerPort = Number(port.containerPort ?? port.port ?? port.servicePort ?? 0);
    if (!containerPort) {
      return;
    }
    const protocol = String(port.protocol || 'tcp').toLowerCase() === 'udp' ? ecs.Protocol.UDP : ecs.Protocol.TCP;
    mappings.push({
      containerPort,
      protocol,
      name: String(port.name || `port-${index}`),
    });
  });
  return mappings;
}

function parseOtelResourceAttributes(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of String(raw || '').split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) {
      continue;
    }
    const index = trimmed.indexOf('=');
    if (index < 0) {
      continue;
    }
    const key = trimmed.slice(0, index).trim();
    if (!key) {
      continue;
    }
    out[key] = trimmed.slice(index + 1).trim();
  }
  return out;
}

function formatOtelResourceAttributes(attrs: Record<string, string>): string {
  return Object.keys(attrs)
    .sort()
    .map((key) => `${key}=${attrs[key]}`)
    .join(',');
}

function canonicalServiceIdentity(fullName: string): { name: string; truncated: boolean } {
  if (fullName.length <= 200) {
    return { name: fullName, truncated: false };
  }
  const sum = createHash('sha256').update(JSON.stringify([fullName])).digest('hex').slice(0, 10);
  let prefix = fullName.slice(0, 189).replace(/[._-]+$/, '');
  if (!prefix) {
    prefix = 'service';
  }
  return { name: `${prefix}.${sum}`, truncated: true };
}

function buildEnvironment(
  env: any,
  partition: string,
  intent: string,
  asset: string,
  account = '',
  region = '',
): Record<string, string> {
  const out: Record<string, string> = {};
  if (env && typeof env === 'object') {
    for (const [key, value] of Object.entries(env)) {
      out[key] = value === null || value === undefined ? '' : String(value);
    }
  }

  const fullName = [partition, intent, asset].filter((part) => Boolean(part)).join('.');
  const identity = canonicalServiceIdentity(fullName);
  const attrs = parseOtelResourceAttributes(out.OTEL_RESOURCE_ATTRIBUTES || '');
  const explicitServiceName = String(out.OTEL_SERVICE_NAME || attrs['service.name'] || '').trim();
  // Canonical identity wins. An explicit workload name is preserved as an
  // alias so existing dashboards can still find it.
  const serviceName = identity.name || explicitServiceName;
  if (serviceName) {
    out.OTEL_SERVICE_NAME = serviceName;
    attrs['service.name'] = serviceName;
  }

  const setGenerated = (key: string, value: string): void => {
    if (key in attrs || !value) {
      return;
    }
    attrs[key] = value;
  };
  setGenerated('service.namespace', partition);
  setGenerated('guardian.partition', partition);
  setGenerated('guardian.intent', intent);
  setGenerated('guardian.asset', asset);
  setGenerated('guardian.identity.kind', 'managed');
  setGenerated('guardian.provider', 'aws');
  for (const key of Object.keys(out).sort()) {
    if (key !== 'OTEL_SERVICE_NAME' && /_OTEL_SERVICE_NAME$/i.test(key) && String(out[key] || '').trim()) {
      setGenerated('service.alias', String(out[key]).trim());
      break;
    }
  }
  if (explicitServiceName && explicitServiceName !== serviceName) {
    setGenerated('service.alias', explicitServiceName);
  }
  if (account) {
    setGenerated('guardian.account', account);
  }
  if (region) {
    setGenerated('guardian.region', region);
  }
  if (fullName) {
    setGenerated('guardian.service.full_name', fullName);
    setGenerated('guardian.service.truncated', identity.truncated && serviceName === identity.name ? 'true' : 'false');
  }
  out.OTEL_RESOURCE_ATTRIBUTES = formatOtelResourceAttributes(attrs);
  return out;
}

function buildSecrets(scope: Construct, asset: string, configParams: any): Record<string, ecs.Secret> {
  const secrets: Record<string, ecs.Secret> = {};
  if (configParams && typeof configParams === 'object') {
    for (const [configName, paramName] of Object.entries(configParams)) {
      const parameter = ssm.StringParameter.fromStringParameterName(
        scope,
        `Param${constructId(asset)}${constructId(configName)}`,
        String(paramName),
      );
      secrets[configName] = ecs.Secret.fromSsmParameter(parameter);
    }
  }
  return secrets;
}

function buildHealthCheck(spec: any): ecs.HealthCheck | undefined {
  if (!spec || typeof spec !== 'object') {
    return undefined;
  }
  const command = stringList(spec.test);
  if (command.length === 0) {
    return undefined;
  }
  return {
    command,
    interval: durationOrUndefined(spec.interval),
    timeout: durationOrUndefined(spec.timeout),
    retries: spec.retries !== undefined ? Number(spec.retries) : undefined,
  };
}

function durationOrUndefined(value: any): cdk.Duration | undefined {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return undefined;
  }
  try {
    return cdk.Duration.parse(raw);
  } catch {
    return undefined;
  }
}

function resolveResources(resources: any): { cpu: number; memory: number } {
  let cpu = 256;
  let memory = 512;
  if (resources && typeof resources === 'object') {
    const limits = resources.limits || {};
    const requests = resources.requests || {};
    if (limits.cpu) {
      cpu = parseCPU(limits.cpu);
    } else if (requests.cpu) {
      cpu = parseCPU(requests.cpu);
    }
    if (limits.memory) {
      memory = parseMemory(limits.memory);
    } else if (requests.memory) {
      memory = parseMemory(requests.memory);
    }
  }
  return { cpu, memory };
}

function parseCPU(raw: any): number {
  let cpu = String(raw ?? '').trim();
  if (!cpu) {
    return 256;
  }
  const millicpu = cpu.endsWith('m');
  if (millicpu) {
    cpu = cpu.slice(0, -1);
  }
  let val = 0;
  let fracDigits = 0;
  for (const ch of cpu) {
    if (ch >= '0' && ch <= '9') {
      if (fracDigits > 0) {
        fracDigits++;
      }
      val = val * 10 + (ch.charCodeAt(0) - 48);
    } else if (ch === '.') {
      fracDigits = 1;
    }
  }
  if (millicpu) {
    val = Math.floor((val * 1024) / 1000);
  } else if (fracDigits > 0) {
    for (let i = 1; i < fracDigits; i++) {
      val = Math.floor(val / 10);
    }
    val = val * 1024;
  }
  if (val === 0) {
    return 256;
  }
  return val < 256 ? 256 : val;
}

function parseMemory(raw: any): number {
  const mem = String(raw ?? '');
  let val = 0;
  for (const ch of mem) {
    if (ch >= '0' && ch <= '9') {
      val = val * 10 + (ch.charCodeAt(0) - 48);
    } else if (ch === 'G' || ch === 'g') {
      val = val * 1024;
      break;
    } else if (ch === 'M' || ch === 'm') {
      break;
    }
  }
  return val === 0 ? 512 : val;
}

function renderOtelConfig(asset: string, props: any, generated: any, region: string): string {
  const mode = String(props.mode || '').toLowerCase();
  const cloudwatchEnabled = props.cloudwatch !== false;
  const exporters: Record<string, any> = {
    awsemf: {
      namespace: generated.namespace,
      region,
      log_group_name: generated.logGroup,
      log_stream_name: asset,
      dimension_rollup_option: 'NoDimensionRollup',
      resource_to_telemetry_conversion: { enabled: true },
    },
  };
  const metricExporters = ['awsemf'];
  const endpoint = String(props.endpoint || '').trim();
  if (endpoint) {
    const protocol = String(props.protocol || '').toLowerCase();
    if (protocol === 'http' || protocol === 'http/protobuf' || endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
      exporters.otlphttp = { endpoint };
      metricExporters.push('otlphttp');
    } else {
      exporters.otlp = { endpoint };
      metricExporters.push('otlp');
    }
  }
  const processors: Record<string, any> = { batch: {} };
  const pipelines: Record<string, any> = {
    metrics: { receivers: ['otlp'], processors: ['batch'], exporters: metricExporters },
  };
  if (cloudwatchEnabled) {
    exporters.awscloudwatchlogs = {
      region,
      log_group_name: generated.logGroup,
      log_stream_name: asset,
    };
    pipelines.logs = { receivers: ['otlp'], processors: ['batch'], exporters: ['awscloudwatchlogs'] };
  }
  const exporterNames = stringList(props.exporters).map((name) => name.toLowerCase());
  const gatewayMode = mode === 'gateway' || mode === 'auto' || mode === 'collector';
  if (exporterNames.includes('xray') || exporterNames.includes('awsxray') || (gatewayMode && cloudwatchEnabled)) {
    exporters.awsxray = { region };
    processors['attributes/xray'] = {
      actions: [{ key: 'peer.service', action: 'delete' }],
    };
    pipelines.traces = {
      receivers: ['otlp'],
      processors: ['attributes/xray', 'batch'],
      exporters: ['awsxray'],
    };
  }
  return JSON.stringify({
    receivers: { otlp: { protocols: { grpc: { endpoint: '0.0.0.0:4317' }, http: { endpoint: '0.0.0.0:4318' } } } },
    processors,
    exporters,
    service: { pipelines },
  });
}

function sanitizeDatabaseName(value: string): string {
  const name = value.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
  if (!name) {
    return 'app';
  }
  return name.slice(0, 63);
}
