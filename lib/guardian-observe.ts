import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

const CLOUDWATCH_AGENT_IMAGE = 'public.ecr.aws/cloudwatch-agent/cloudwatch-agent:latest';
const AGENT_CONTAINER_NAME = 'cloudwatch-agent';
const DEFAULT_SSM_PREFIX = '/guardian/onboarding';

export interface GuardianObserveRepo {
  url: string;
  branch?: string;
  selector?: string;
  sourcePath?: string;
}

export interface GuardianObservePublish {
  mode?: 'store' | 'repo';
  repo?: string;
  branch?: string;
}

export interface GuardianObserveProbe {
  name: string;
  type?: 'http' | 'https' | 'tcp' | 'tls' | 'dns' | 'grpc';
  url?: string;
  address?: string;
  port?: number;
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  expectStatus?: number[];
  interval?: string;
  timeout?: string;
  retries?: number;
  insecureSkipVerify?: boolean;
  labels?: Record<string, string>;
}

export interface GuardianObserveTelemetry {
  /** Add a CloudWatch agent sidecar to every target task definition. Default true. */
  enabled?: boolean;
  /** CloudWatch log group the app already writes to (for dashboards/queries). */
  logGroup?: string;
  /** Dashboard telemetry source: aws (CloudWatch) or doctor (central demo). */
  source?: 'aws' | 'doctor';
  /** Override the CloudWatch agent image. */
  image?: string;
}

export interface GuardianObserveProps {
  /**
   * One partition per account environment, shared by every stack in it.
   * Example: customer-acme-prod-2.
   */
  partition: string;
  /** Intent name. Defaults to a slug of the stack name. */
  intent?: string;
  /** Read-only source repository used by Guardian to synthesize observed intents. */
  repo?: GuardianObserveRepo;
  /** Where Guardian publishes the generated partition bundle. */
  publish?: GuardianObservePublish;
  /** Probe targets owned by this stack. */
  probes?: GuardianObserveProbe[];
  /** Customer-side CloudWatch OTLP ingestion. */
  telemetry?: GuardianObserveTelemetry;
  /**
   * ECS services whose task definitions should receive the CloudWatch agent
   * sidecar and OTLP environment. The construct is per stack; the pusher is
   * account-level and is deployed separately.
   */
  targets?: ecs.FargateService[];
  /** SSM parameter prefix. Defaults to /guardian/onboarding. */
  ssmPrefix?: string;
}

/**
 * GuardianObserve publishes the onboarding contract for one customer stack:
 * stack tags, an SSM descriptor, and a CloudWatch agent sidecar that forwards
 * OTLP telemetry to CloudWatch. It deliberately does not create the pusher or
 * a Guardian partition; Guardian pulls the descriptor and materializes the
 * partition itself.
 */
export class GuardianObserve extends Construct {
  public readonly parameterName: string;
  public readonly otelEndpoint = 'http://localhost:4317';

  constructor(scope: Construct, id: string, props: GuardianObserveProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const partition = required(props.partition, 'partition');
    const stackName = stack.stackName;
    const intent = props.intent?.trim() || slug(stackName);
    const prefix = (props.ssmPrefix || DEFAULT_SSM_PREFIX).replace(/\/+$/, '');
    const publish = props.publish ?? { mode: 'store' };
    const telemetry = props.telemetry ?? {};
    const telemetryEnabled = telemetry.enabled ?? true;

    cdk.Tags.of(stack).add('guardian.io/observe', 'true');
    cdk.Tags.of(stack).add('guardian.io/partition', partition);
    cdk.Tags.of(stack).add('guardian.io/intent', intent);
    stack.tags.setTag('guardian.io/observe', 'true');
    stack.tags.setTag('guardian.io/partition', partition);
    stack.tags.setTag('guardian.io/intent', intent);
    if (props.repo?.url) {
      cdk.Tags.of(stack).add('guardian.io/repo', props.repo.url);
      stack.tags.setTag('guardian.io/repo', props.repo.url);
    }

    const descriptor = {
      apiVersion: 'guardian/v1alpha1',
      kind: 'Onboarding',
      account: stack.account,
      region: stack.region,
      stack: stackName,
      partition,
      intent,
      ...(props.repo?.url ? { repo: props.repo } : {}),
      publish,
      telemetry: {
        mode: 'cloudwatch-agent',
        ...(telemetry.logGroup ? { logGroup: telemetry.logGroup } : {}),
        ...(telemetry.source ? { source: telemetry.source } : {}),
      },
      probes: props.probes ?? [],
    };

    this.parameterName = `${prefix}/${stackName}`;
    const descriptorJSON = JSON.stringify(descriptor);
    const parameter = new ssm.StringParameter(this, 'OnboardingDescriptor', {
      parameterName: this.parameterName,
      description: `Guardian onboarding contract for ${stackName}`,
      stringValue: descriptorJSON,
      // Standard parameters are capped at 4 KB. Rich probe sets can exceed
      // that; advanced parameters allow 8 KB.
      tier: descriptorJSON.length > 3500 ? ssm.ParameterTier.ADVANCED : ssm.ParameterTier.STANDARD,
    });

    if (telemetryEnabled) {
      const agentConfig = {
        agent: { region: stack.region },
        opentelemetry: {
          resource_attributes: {
            'guardian.partition': partition,
            'guardian.intent': intent,
            'guardian.stack': stackName,
            'guardian.account': stack.account,
            'guardian.region': stack.region,
          },
          collect: {
            otlp: {
              grpc_endpoint: '0.0.0.0:4317',
              http_endpoint: '0.0.0.0:4318',
            },
          },
        },
      };
      for (const target of props.targets ?? []) {
        const containers = taskContainers(target.taskDefinition);
        addAgentToTask(target, agentConfig, telemetry.image);
        for (const container of containers) {
          if (container.containerName === AGENT_CONTAINER_NAME) {
            continue;
          }
          container.addEnvironment('OTEL_EXPORTER_OTLP_ENDPOINT', this.otelEndpoint);
          container.addEnvironment('OTEL_EXPORTER_OTLP_PROTOCOL', 'grpc');
        }
      }
    }

    new cdk.CfnOutput(this, 'OnboardingParameter', {
      value: parameter.parameterName,
      description: 'Guardian pulls this SSM parameter through the account pusher',
    });
    new cdk.CfnOutput(this, 'GuardianOtelEndpoint', {
      value: this.otelEndpoint,
      description: 'Local CloudWatch agent OTLP endpoint for the application',
    });
  }
}

function addAgentToTask(
  target: ecs.FargateService,
  config: Record<string, unknown>,
  image?: string,
): void {
  const taskDefinition = target.taskDefinition;
  if (taskContainers(taskDefinition).some((container) => container.containerName === AGENT_CONTAINER_NAME)) {
    return;
  }
  taskDefinition.addContainer(AGENT_CONTAINER_NAME, {
    image: ecs.ContainerImage.fromRegistry(image || CLOUDWATCH_AGENT_IMAGE),
    essential: false,
    environment: {
      CW_CONFIG_CONTENT: JSON.stringify(config),
    },
    logging: ecs.LogDrivers.awsLogs({ streamPrefix: AGENT_CONTAINER_NAME }),
  });
  taskDefinition.taskRole.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: [
        'cloudwatch:PutMetricData',
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'xray:PutTraceSegments',
        'xray:PutTelemetryRecords',
      ],
      resources: ['*'],
    }),
  );
}

function taskContainers(taskDefinition: ecs.TaskDefinition): ecs.ContainerDefinition[] {
  return taskDefinition.node
    .findAll()
    .filter((child): child is ecs.ContainerDefinition => child instanceof ecs.ContainerDefinition);
}

function required(value: string, name: string): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    throw new Error(`GuardianObserve: ${name} is required`);
  }
  return trimmed;
}

function slug(value: string): string {
  const out = value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return out || 'stack';
}
