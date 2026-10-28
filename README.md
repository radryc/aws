# Strata on AWS

CDK (TypeScript) project that deploys **MonoFS** and **Guardian** to **ECS Fargate** via CloudFormation.

## Architecture

```
                          internet
                             │
                     ┌───────▼────────┐
                     │   ALB (HTTP)    │
                     │ /monofs  /*     │
                     └───┬────────┬────┘
                         │        │
          ┌──────────────▼──┐  ┌─▼──────────────┐
          │  monofs-router   │  │   guardiand     │
          │  gRPC:9090       │  │   HTTP:8090     │
          │  HTTP:8080       │  └─────────────────┘
          └──┬───────┬───────┘
             │       │
     ┌───────▼──┐ ┌──▼────────┐
     │  server   │ │  fetcher   │
     │  :9000    │ │  :9200     │
     │  :7000    │ └────────────┘
     │  :9100    │
     └───┬───────┘
         │
    ┌────▼────┐   ┌──────────┐
    │   EFS   │   │    S3     │
    │ (data)  │   │ (blobs)   │
    └─────────┘   └──────────┘

All services run in private subnets behind a NAT gateway.
Service Connect provides internal DNS (strata.local).
```

## Prerequisites

- **AWS account** with IAM permissions to create VPC, ECS, EFS, S3, Secrets Manager, IAM, ALB, CloudWatch
- **AWS CLI** installed and configured (`aws configure` or `aws sso login`)
- **Node.js** >= 18
- **Docker** (running, with BuildKit) — CDK builds Docker images locally and pushes to ECR
- Network access to GitHub and the Go module proxy during image builds

The scripts use `AWS_PROFILE` and default to the `default` profile. Select a
different profile explicitly:

```bash
export AWS_PROFILE=my-profile
export AWS_REGION=us-east-1
```

Bootstrap CDK in your account (once per account/region):

```bash
npm run bootstrap
```

## Quick Start

```bash
npm install
npm run synth          # synthesize CloudFormation (no deploy)
npm run diff           # preview changes against deployed stack
npm run deploy         # deploy the stack
```

## Container sources

This repository is standalone: `docker/` contains only Dockerfiles and
`docker/fetch-source.sh`. Each Dockerfile fetches the pinned public Strata
source repositories (`monofs`, `guardian`, `doctor`, `kvs`, `cfg`) at build
time, so no sibling checkout is required.

The refs are declared as `ARG` values at the top of each Dockerfile. To move to
a newer source revision, update the relevant `*_REF` values:

```bash
grep -n "ARG .*_REF" docker/*.Dockerfile
```

You can also override them per build (`--build-arg MONOFS_REF=<sha>`).

## Observability plane (Doctor + OTLP gateway + VPC Lattice)

`ObservabilityStack` adds the AWS-hosted trace plane:

- `doctor-ingest` (OTLP 4317/4318 → MonoFS)
- `doctor-query` (UI/API 18080, public CloudFront HTTPS + Cognito OIDC)
- `guardian-otlp-gateway` (OTLP receiver → Doctor)
- VPC Lattice service network `strata-observability` and service `strata-otlp`
- optional AWS RAM share for workload accounts

```bash
npx cdk deploy StrataStack ObservabilityStack \
  -c deploySSO=true \
  -c deployObservability=true \
  -c deployAwsPusher=false \
  -c deployDemoStack=false \
  -c otlpPartition= \
  -c latticePrincipalAccounts=111111111111,222222222222
```

Outputs: `OtlpServiceDns`, `OtlpServiceNetworkArn`,
`OtlpIngestTokenSecretArn`, `DoctorQueryUrl`, `DoctorAccessMode`.
`StrataStack` also outputs `GuardianAccessPolicyTokenSecretArn` and
`DoctorUrl`.

`ClientVpnStack` is optional and is used by the AWS control-plane demo to
connect a local kind workload to the private Lattice OTLP gateway. It requires
imported ACM server/client-CA certificates:

```bash
scripts/client-vpn-certs.sh --profile default --region us-east-1 \
  --out-dir ./clientvpn

npx cdk deploy ClientVpnStack \
  -c deploySSO=true \
  -c deployObservability=true \
  -c deployClientVpn=true \
  -c vpnServerCertificateArn=<server-arn> \
  -c vpnClientRootCertificateArn=<client-ca-arn>
```

See the `docs/observability/control-plane-profiles.md` and
`docs/observability/aws-deployment.md` documents in the Strata project.

## Configuration

All toggles live in `cdk.json` under `context`:

| Key | Default | Description |
|---|---|---|
| `deployMonofsServer` | `true` | MonoFS storage node |
| `deployMonofsRouter` | `true` | ALB-exposed HTTP/gRPC router |
| `deployMonofsFetcher` | `true` | S3 blob fetcher |
| `deployMonofsRegistry` | `false` | Docker registry |
| `deployMonofsSearch` | `false` | Search index |
| `deployGuardian` | `true` | Guardian control plane |
| `deploySSO` | `false` | Amazon Cognito SSO for MonoFS + Guardian |
| `serverCount` | `1` | MonoFS server replicas |
| `routerCount` | `1` | MonoFS router replicas |
| `fetcherCount` | `1` | Fetcher replicas |
| `guardianCount` | `1` | Guardian replicas |
| `deployObservability` | `true` | Doctor + OTLP gateway + VPC Lattice |
| `deployClientVpn` | `false` | AWS Client VPN for local kind → AWS in the AWS control-plane demo |
| `otlpPartition` | empty | Fixed partition for a per-partition gateway; empty preserves app value |
| `otlpStampAccount` | `false` | Stamp account/region when the gateway is in the workload account |
| `latticePrincipalAccounts` | empty | Comma-separated accounts to share the Lattice service network with |
| `otlpGatewayReplicas` | `1` | OTLP gateway replicas |
| `doctorIngestReplicas` | `1` | Doctor ingest replicas |
| `doctorQueryReplicas` | `1` | Doctor query replicas |
| `doctorFederationEnabled` | `false` | Enable Doctor's multi-account AWS read catalog |
| `doctorFederationCatalogJSON` | empty | Inline federation catalog (ECS) |
| `doctorFederationTokenSecrets` | empty | JSON map of catalog `token_env` -> Secrets Manager ARN |
| `fleetTargetAccounts` | empty | Comma-separated accounts for `AwsPusherFleetStack` |
| `fleetAssumeRoleName` | `GuardianCdkDeployRole` | Role assumed by fleet pushers in target accounts |
| `awsReadEndpoint` | empty | Legacy single pusher read API URL |
| `awsReadTokenSecretArn` | empty | Secret ARN for the legacy read API token |

Override on the CLI:

```bash
npx cdk deploy -c deployMonofsSearch=true -c serverCount=3
```

## SSO (Amazon Cognito)

Enable SSO to require authentication for Guardian UI and MonoFS router:

```bash
npm run deploy -- -c deploySSO=true
```

This provisions:
- **Cognito User Pool** (email-based sign-in)
- **App Client** (OIDC authorization code flow + PKCE)
- **Hosted UI** at `https://<domain>.auth.<region>.amazoncognito.com`
- **Client secret** stored in Secrets Manager (`strata/cognito/client-secret`)

### Create users

After deploy, create users in the AWS Console:

1. Go to **Cognito** → **User pools** → `strata`
2. Click **Users** → **Create user**
3. Enter email (this is what grants match), set a temporary password
4. User signs in at the hosted UI → sets permanent password

### How it works

- Guardian UI (`/auth/login`) redirects to Cognito hosted UI
- After sign-in, Cognito redirects back to `/auth/callback` with an auth code
- Guardian exchanges the code for tokens and sets a session cookie
- MonoFS router (`/monofs/auth/login`) does the same via `/monofs/auth/callback`
- API calls use `Authorization: Bearer <id_token>` header
- Default grant: `admin@example.com` gets admin on all partitions

### Grants

Grants are configured via `MONOFS_AUTHZ_GRANTS_JSON`:

```json
[{"subject":"admin@example.com","partition":"*","role":"admin"}]
```

Roles: `viewer` (read) → `ingester` (read+write) → `maintainer` (read+write+deploy) → `admin` (all partitions).

### Without SSO

The static `MONOFS_TOKEN` from Secrets Manager remains available as a break-glass mechanism. Both auth paths work simultaneously.

## Pre-Deploy: Encryption Key

Before the first deploy, set the MonoFS encryption key:

```bash
aws secretsmanager put-secret-value \
  --secret-id strata/monofs/encryption-key \
  --secret-string "$(openssl rand -hex 32)"
```

The CDK creates the secret placeholder. You must populate it for the services to start.

## Resources Created

| Resource | Details |
|---|---|
| **VPC** | 2 AZs, public + private subnets, 1 NAT gateway |
| **ECS Cluster** | `strata`, Fargate, Container Insights enabled |
| **ECS Services** | monofs-server, monofs-router, monofs-fetcher, guardiand (+ optional registry, search) |
| **ALB** | Internet-facing HTTP on port 80 |
| **EFS** | Encrypted, lifecycle to IA after 14 days, access points for server/fetcher/search |
| **S3** | `monofs-blobs-{account}-{region}`, versioned, encrypted, 30-day noncurrent expiration |
| **Secrets Manager** | `strata/monofs/encryption-key`, `strata/monofs/token` |
| **CloudWatch** | Log group `/ecs/strata`, 14-day retention |
| **IAM** | Execution roles and task roles with least-privilege permissions |
| **Security Groups** | ALB, MonoFS (internode + ALB ingress), Guardian, EFS |
| **Cognito** (SSO) | User Pool, App Client, Hosted UI domain, client secret in Secrets Manager |

## Outputs

After deployment, `cdk deploy` prints:

| Output | Purpose |
|---|---|
| `AlbDnsName` | ALB DNS — Guardian UI at `/`, MonoFS at `/monofs/` |
| `EcsClusterName` | ECS cluster name (`strata`) |
| `BlobBucketName` | S3 bucket for blob storage |
| `EfsFileSystemId` | EFS filesystem ID |
| `EncryptionKeySecretArn` | Secret ARN for the encryption key |
| `CognitoUserPoolId` (SSO) | Cognito User Pool ID |
| `CognitoClientId` (SSO) | Cognito App Client ID |
| `CognitoHostedUIUrl` (SSO) | Cognito hosted UI URL |

## Account observability (CloudWatch + X-Ray → Grafana)

Deploying `AwsPusherStack` enables the per-account read-only observability API
that Doctor federates into Grafana (CloudWatch PromQL, Logs Insights, X-Ray).
See `guardian/docs/aws-observability-enablement.md` in the Guardian
repository for what is provisioned automatically and the few remaining wiring
steps.

## CloudFormation observation (observed intents)

`AwsPusherStack` also provisions an EventBridge rule and SQS queue
(`guardian-aws-observe`, plus a DLQ) that carry CloudFormation stack status and
drift detection events to the pusher. Guardian pulls the resulting observed
state from the pusher read API and reports drift against the CDK app stored in
MonoFS. See `guardian/docs/aws-observed.md` in the Guardian repository.
Disable with `npx cdk deploy -c deployAwsObserve=false`.

## Useful Commands

```bash
npm run deploy    -- deploy the stack
npm run destroy   -- tear down the stack
npm run synth     -- synthesize CloudFormation template
npm run diff      -- show changes vs deployed stack
```

## Directory Structure

```
.
├── bin/
│   └── strata.ts              # CDK app entry point
├── lib/
│   ├── docker-assets.ts       # Shared Docker image asset helper
│   ├── strata-stack.ts        # MonoFS + Guardian (VPC, ECS, ALB, EFS, S3, IAM, …)
│   ├── observability-stack.ts # Doctor + OTLP gateway + VPC Lattice
│   ├── aws-pusher-stack.ts    # Per-account observability/read API pusher
│   ├── aws-pusher-fleet-stack.ts
│   ├── aws-observed-pusher-stack.ts
│   └── client-vpn-stack.ts
├── docker/
│   ├── fetch-source.sh        # Fetches a pinned public source repo
│   └── *.Dockerfile           # Standalone image builds
├── scripts/
│   ├── client-vpn-certs.sh
│   └── client-vpn-config.sh
├── templates/                 # Guardian AWS asset templates
├── test/                      # Jest unit/snapshot tests
├── cdk.json                   # CDK configuration & context toggles
├── package.json               # Dependencies & scripts
└── tsconfig.json              # TypeScript config
```

## Teardown

```bash
npm run destroy
```

Note: The S3 bucket and EFS filesystem have `removalPolicy: DESTROY`, so they will be deleted. Secrets Manager secrets and CloudWatch log groups are also destroyed.
