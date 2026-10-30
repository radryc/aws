import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface SentinelProbeTarget {
  name: string;
  type?: string;
  service?: string;
}

export interface SentinelDefaultAlarmsProps {
  /** Enable the default alarm pack. Default true. */
  enabled?: boolean;
  /** Enable probe alarms. Default true. */
  probeAlarms?: boolean;
  /** Enable pusher/read-API alarms. Default true. */
  pusherAlarms?: boolean;
  /**
   * Optional SNS topic ARN. When set, alarms use `delivery: native`.
   * When unset, alarms have no actions and Sentinel owns delivery.
   */
  snsTopicArn?: string;
  /** CloudWatch namespace for Guardian probe metrics. Default Strata/Guardian. */
  probeNamespace?: string;
  /** Probe failure threshold. Default 2. */
  probeFailureThreshold?: number;
  /** Probe stale threshold in seconds. Default 300. */
  probeStaleSeconds?: number;
  /** Probe interval used to derive the stale threshold when set. */
  probeIntervalSeconds?: number;
  /** Explicit probes; when omitted, fleet-level alarms are created. */
  probes?: SentinelProbeTarget[];
  /** Pusher identity and partition tags. */
  pusherName: string;
  partition?: string;
  intent?: string;
  service?: ecs.FargateService;
  queue?: sqs.IQueue;
  dlq?: sqs.IQueue;
  cpuThreshold?: number;
  memoryThreshold?: number;
  tags?: Record<string, string>;
}

/**
 * Default CloudWatch alarms for the AWS pusher and its probe telemetry.
 *
 * In `delivery: sentinel` mode (no snsTopicArn), alarms have no actions and
 * Sentinel discovers them through the pusher read API. In native mode they
 * publish to the supplied SNS topic and Sentinel only presents them.
 */
export class SentinelDefaultAlarms extends Construct {
  public readonly alarms: cloudwatch.IAlarm[] = [];
  private readonly partition?: string;
  private readonly intent?: string;

  constructor(scope: Construct, id: string, props: SentinelDefaultAlarmsProps) {
    super(scope, id);
    this.partition = props.partition?.trim() || undefined;
    this.intent = props.intent?.trim() || undefined;

    if (props.enabled === false) {
      return;
    }

    const namespace = props.probeNamespace ?? 'Strata/Guardian';
    const failureThreshold = props.probeFailureThreshold ?? 2;
    const staleSeconds =
      props.probeStaleSeconds ??
      Math.max(300, (props.probeIntervalSeconds ?? 30) * 3);
    const topic = props.snsTopicArn
      ? sns.Topic.fromTopicArn(this, 'AlarmTopic', props.snsTopicArn)
      : undefined;

    if (props.probeAlarms ?? true) {
      const probes = props.probes ?? [];
      if (probes.length > 0) {
        for (const probe of probes) {
          const dimensions: Record<string, string> = {
            'guardian.probe.name': probe.name,
          };
          if (probe.type) dimensions['guardian.probe.type'] = probe.type;
          if (probe.service) dimensions.service = probe.service;
          if (props.partition) dimensions['guardian.partition'] = props.partition;
          this.addProbeAlarms(probe.name, namespace, dimensions, failureThreshold, staleSeconds, topic);
        }
      } else {
        const dimensions: Record<string, string> = {};
        if (props.partition) dimensions['guardian.partition'] = props.partition;
        this.addProbeAlarms('fleet', namespace, dimensions, failureThreshold, staleSeconds, topic);
      }
    }

    if (props.pusherAlarms ?? true) {
      this.addPusherAlarms(props, topic);
    }
  }

  private addProbeAlarms(
    scopeName: string,
    namespace: string,
    dimensions: Record<string, string>,
    failureThreshold: number,
    staleSeconds: number,
    topic?: sns.ITopic,
  ): void {
    const base = `${sanitize(this.node.path)}-${sanitize(scopeName)}`;
    const period = cdk.Duration.minutes(1);

    this.addAlarm(`${base}-probe-down`, {
      alarmName: `${base}-probe-down`,
      metric: new cloudwatch.Metric({
        namespace,
        metricName: 'guardian.probe.up',
        dimensionsMap: dimensions,
        statistic: cloudwatch.Stats.MINIMUM,
        period,
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      topic,
      description: 'Guardian probe is down or not reporting',
    });

    this.addAlarm(`${base}-probe-failures`, {
      alarmName: `${base}-probe-failures`,
      metric: new cloudwatch.Metric({
        namespace,
        metricName: 'guardian.probe.consecutive_failures',
        dimensionsMap: dimensions,
        statistic: cloudwatch.Stats.MAXIMUM,
        period,
      }),
      threshold: failureThreshold,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      topic,
      description: 'Guardian probe has consecutive failures',
    });

    this.addAlarm(`${base}-probe-stale`, {
      alarmName: `${base}-probe-stale`,
      metric: new cloudwatch.Metric({
        namespace,
        metricName: 'guardian.probe.state_age.seconds',
        dimensionsMap: dimensions,
        statistic: cloudwatch.Stats.MAXIMUM,
        period,
      }),
      threshold: staleSeconds,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      topic,
      description: 'Guardian probe state is stale',
    });
  }

  private addPusherAlarms(props: SentinelDefaultAlarmsProps, topic?: sns.ITopic): void {
    const base = `${sanitize(this.node.path)}-${sanitize(props.pusherName)}`;

    if (props.service) {
      this.addAlarm(`${base}-cpu`, {
        alarmName: `${base}-cpu`,
        metric: props.service.metricCpuUtilization({ period: cdk.Duration.minutes(5), statistic: cloudwatch.Stats.AVERAGE }),
        threshold: props.cpuThreshold ?? 85,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        topic,
        description: 'Pusher ECS CPU utilization is high',
      });

      this.addAlarm(`${base}-memory`, {
        alarmName: `${base}-memory`,
        metric: props.service.metricMemoryUtilization({ period: cdk.Duration.minutes(5), statistic: cloudwatch.Stats.AVERAGE }),
        threshold: props.memoryThreshold ?? 85,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        topic,
        description: 'Pusher ECS memory utilization is high',
      });
    }

    if (props.queue) {
      this.addAlarm(`${base}-queue-age`, {
        alarmName: `${base}-queue-age`,
        metric: props.queue.metricApproximateAgeOfOldestMessage({ period: cdk.Duration.minutes(5), statistic: cloudwatch.Stats.MAXIMUM }),
        threshold: 300,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        topic,
        description: 'Pusher observe queue is backlogged',
      });
    }

    if (props.dlq) {
      this.addAlarm(`${base}-dlq`, {
        alarmName: `${base}-dlq`,
        metric: props.dlq.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5), statistic: cloudwatch.Stats.MAXIMUM }),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        topic,
        description: 'Pusher observe dead-letter queue has messages',
      });
    }
  }

  private addAlarm(
    id: string,
    props: {
      alarmName: string;
      metric: cloudwatch.IMetric;
      threshold: number;
      comparisonOperator: cloudwatch.ComparisonOperator;
      evaluationPeriods: number;
      treatMissingData: cloudwatch.TreatMissingData;
      topic?: sns.ITopic;
      description: string;
    },
  ): void {
    const alarm = new cloudwatch.Alarm(this, id, {
      alarmName: props.alarmName,
      alarmDescription: props.description,
      metric: props.metric,
      threshold: props.threshold,
      comparisonOperator: props.comparisonOperator,
      evaluationPeriods: props.evaluationPeriods,
      datapointsToAlarm: props.evaluationPeriods,
      treatMissingData: props.treatMissingData,
      actionsEnabled: Boolean(props.topic),
    });
    this.alarms.push(alarm);
    if (props.topic) {
      alarm.addAlarmAction(new cwActions.SnsAction(props.topic));
    }
    cdk.Tags.of(alarm).add('guardian.io/managed-by', 'guardian');
    cdk.Tags.of(alarm).add('sentinel.io/import', 'true');
    cdk.Tags.of(alarm).add('sentinel.io/delivery', props.topic ? 'native' : 'sentinel');
    cdk.Tags.of(alarm).add('sentinel.io/rule-pack', 'default');
    cdk.Tags.of(alarm).add('sentinel.io/component', id.includes('probe') ? 'probe' : 'pusher');
    if (this.partition) {
      cdk.Tags.of(alarm).add('guardian.io/partition', this.partition);
    }
    if (this.intent) {
      cdk.Tags.of(alarm).add('guardian.io/intent', this.intent);
    }
  }
}

function sanitize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}
