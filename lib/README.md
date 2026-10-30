# Guardian customer constructs

`guardian-observe.ts` is the customer-facing side of observed onboarding. Copy it
into a customer CDK app (or publish it as an internal package) and instantiate it
once per stack:

```ts
import { GuardianObserve } from './lib/guardian-observe';

const service = new ecs.FargateService(this, 'Service', { ... });

new GuardianObserve(this, 'Guardian', {
  partition: 'customer-acme-prod-2',
  repo: { url: 'https://github.com/acme/app.git', branch: 'main' },
  probes: [{ name: 'health', type: 'http', url: alb.loadBalancerDnsName, path: '/healthz' }],
  telemetry: { logGroup: logGroup.logGroupName },
  targets: [service],
});
```

It creates:

- an SSM descriptor at `/guardian/onboarding/<stack>`,
- stack tags (`guardian.io/observe`, `guardian.io/partition`, `guardian.io/intent`),
- a CloudWatch agent sidecar on every target task definition, listening on
  `localhost:4317`/`4318` and forwarding OTLP to CloudWatch,
- minimal task-role permissions for CloudWatch metrics, Logs and X-Ray.

It does **not** create the pusher or a Guardian partition. Deploy one
`AwsObservedPusherStack` per account/region and let Guardian pull the descriptor.

See `guardian/docs/customer-onboarding.md` for the full flow.

## Sentinel default alarms

`SentinelDefaultAlarms` adds a default CloudWatch alarm pack to the AWS pusher
stacks:

- probe down, consecutive failures, and stale probe state,
- pusher CPU/memory,
- SQS observe queue age and DLQ depth,
- optional per-probe alarms when `probes` is supplied.

Alarms are tagged with `guardian.io/managed-by=guardian`,
`sentinel.io/import=true`, `sentinel.io/rule-pack=default`, and
`sentinel.io/component`. With no `snsTopicArn`, alarms have no actions and
Sentinel polls them through the pusher read API (`delivery: sentinel`). With an
`snsTopicArn`, alarms publish to SNS (`delivery: native`).
