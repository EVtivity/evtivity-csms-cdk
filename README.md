# EVtivity CSMS - AWS CDK

AWS CDK infrastructure for the EVtivity Charging Station Management System. Companion to `evtivity-csms-helm` (Kubernetes); this repo provisions the equivalent platform on AWS using ECS Fargate, Aurora PostgreSQL Serverless v2, ElastiCache Redis, ALB with WAF, and supporting services.

## Layout

```
evtivity-csms-cdk/
├── bin/app.ts                    # CDK app entry, picks env from --context
├── lib/
│   ├── config/
│   │   ├── schema.ts             # zod schema for all YAML config
│   │   └── load.ts               # loader: <env>.yaml + <env>.local.yaml deep-merge
│   ├── stacks/
│   │   ├── network-stack.ts      # VPC, SGs, VPC endpoints, flow logs
│   │   ├── domain-stack.ts       # Route 53 zone reference, ACM cert
│   │   ├── storage-stack.ts      # S3 buckets (support, station images, ALB logs)
│   │   ├── data-stack.ts         # Aurora Serverless v2, ElastiCache Redis
│   │   ├── alb-stack.ts          # Application Load Balancer + WAFv2
│   │   ├── ecs-stack.ts          # ECS cluster, services, NLB for OCPP TLS
│   │   └── monitoring-stack.ts   # Optional CloudWatch dashboard + AMP workspace
│   └── constructs/
│       ├── csms-service.ts       # Per-service Fargate task + scaling + ALB rules
│       └── secure-bucket.ts      # S3 with hardened defaults (block public, SSE, etc.)
├── config/
│   ├── dev.yaml                  # committed defaults, placeholder account
│   ├── qa.yaml
│   ├── prod.yaml
│   ├── dev.local.yaml.example    # template for local overrides
│   └── *.local.yaml              # gitignored, your real values
├── docs/
│   ├── deployment.md
│   └── security.md
├── .github/workflows/
│   ├── ci.yml                    # typecheck + lint + cdk synth on PR
│   └── deploy.yml                # workflow_dispatch with env input
├── .husky/commit-msg             # commitlint hook (conventional commits)
├── cdk.context.json              # placeholder lookup cache so CI synth works without AWS creds
├── commitlint.config.cjs
├── cdk.json
├── package.json
├── tsconfig.json
└── eslint.config.js
```

## Environments

| Env | Purpose | Sizing |
|---|---|---|
| `dev` | Engineer testing | Smallest infra (single NAT, 0.5 ACU Aurora, t4g.micro Redis, 0.25 vCPU Fargate) |
| `qa` | Pre-prod verification | Medium (single NAT, 1 ACU Aurora, t4g.small Redis, 0.5 vCPU Fargate) |
| `prod` | Customer-facing | Multi-AZ everywhere, Aurora autoscale 2-16 ACU, Redis with replica, Fargate autoscale |

All in `us-east-1`, single AWS account. Hostnames:

- dev: `<service>.dev.<apex>` (e.g. `csms.dev.evtivity.com`)
- qa: `<service>.qa.<apex>`
- prod: `<service>.<apex>` (bare apex - prod's `domain.subdomain` is `""`)

## Quick start

Prerequisites:
- AWS account with credentials configured (e.g., `aws sso login`)
- Node.js 22+
- `npm install -g aws-cdk` (or use `npx`)
- A Route 53 hosted zone for your apex domain in the same AWS account

```bash
npm install                                            # also installs husky commit hook
cp config/dev.local.yaml.example config/dev.local.yaml # then edit with your real values
rm cdk.context.json                                    # discard placeholder cache so CDK queries your account

npm run typecheck
npx cdk bootstrap aws://ACCOUNT_ID/us-east-1           # one-time per account/region
npm run synth -- --context env=dev                     # render templates
npm run deploy -- --context env=dev --all              # deploy all stacks
```

After the first deploy, run the migrate task and seed the initial admin - see [`docs/deployment.md`](docs/deployment.md).

## Configuration

Each environment is driven by `config/<env>.yaml`. Optional **local overrides** live in `config/<env>.local.yaml` (gitignored). The loader deep-merges the local file on top of the committed one and validates the result against the zod schema, so partial overrides are safe:

```yaml
# config/dev.yaml (committed)
account: "111111111111"
domain:
  apex: evtivity.com
  subdomain: dev
services:
  api:
    imageTag: v0.1.2
```

```yaml
# config/dev.local.yaml (gitignored, your real values)
account: "835568951219"
domain:
  hostedZoneId: Z02116493GWRTPSPQ6PFU
services:
  api:
    imageTag: v0.1.5
```

Same pattern for `qa.local.yaml` and `prod.local.yaml`. Useful for AWS account IDs, hosted zone IDs, image tags pinned beyond the committed default, and toggling optional features (below).

## Optional features

All default to disabled. Flip them on per env, usually in `<env>.local.yaml`. Operator-pre-create requirements documented in [`docs/deployment.md`](docs/deployment.md).

### `ocppTls` - SP3 mTLS for OCPP

Adds an internet-facing NLB on `ocppTls.port` (default 8443) with TCP passthrough so the OCPP server terminates TLS and validates SP3 client certificates. Server cert/key/CA come from a Secrets Manager JSON secret (keys `cert`, `key`, `ca`).

```yaml
ocppTls:
  enabled: true
  secretName: evtivity/dev/ocpp-tls
  port: 8443
```

### `cssTls` - Charging Station Simulator client cert

Same shape as `ocppTls`. Lets the simulator connect to OCPP over SP3 mTLS for end-to-end testing.

### `serviceConnect` - east-west service discovery (and optional mTLS)

Provisions a private Cloud Map namespace (default `csms.local`) and registers each Fargate service. Pods reach each other at `<service>.<namespace>` (e.g. `api.csms.local`).

```yaml
serviceConnect:
  enabled: true
  namespace: csms.local
  tls:
    enabled: true
    privateCaArn: arn:aws:acm-pca:us-east-1:ACCOUNT:certificate-authority/UUID
```

Setting `tls.enabled: true` requires a Private CA ARN. AWS Private CA is ~$400/month - leave TLS off in dev/qa unless you have a compliance driver in prod.

### `monitoring` - CloudWatch dashboard + AMP workspace

Adds an `Evtivity-<Env>-Monitoring` stack with:

- A CloudWatch dashboard (`evtivity-<env>`) covering ECS service CPU/memory, ALB request count and 5xx, target latency p95, Aurora ACU and connections, Redis CPU and cache hit rate.
- An Amazon Managed Prometheus workspace for Prometheus-style scraping. Wire Amazon Managed Grafana to the workspace separately (AMG is account-level and requires SSO setup).

Container Insights is on for the ECS cluster regardless of this toggle.

## Image source

ECS pulls container images from `ghcr.io/evtivity/*` (the public registry maintained by `evtivity-csms-private`). The CDK does not provision ECR. Image tags come from `config/{env}.yaml` -> `services.<name>.imageTag`. The CSMS release pipeline auto-bumps tags here on tag push - see the release workflow in `evtivity-csms-private/.github/workflows/release.yml`.

## Frontend runtime config

CSMS and Portal containers ship with a runtime-config script that writes `/runtime-config.js` from `RUNTIME_*_URL` env vars at container startup. The CDK derives those URLs from `domain.subdomain` + each service's `hostnamePrefix` and injects them automatically. CORS_ORIGIN on the API container is also auto-derived from the CSMS and Portal URLs unless `services.api.env.CORS_ORIGIN` is set explicitly.

## Initial admin user

The migrate image ships `packages/database/src/seed-admin.ts`. Run it on demand via `aws ecs run-task --overrides '{"containerOverrides":[{"name":"app","command":["sh","-c","cd packages/database && npm run seed:admin"]}]}'`. See [`docs/deployment.md`](docs/deployment.md) for the dev/prod recipes (env-var password vs Secrets-Manager-backed).

## Security posture

This stack is designed to pass the high-impact rules in:

- AWS Foundational Security Best Practices
- CIS AWS Foundations Benchmark v3.0

Without enabling AWS Security Hub itself. See [`docs/security.md`](docs/security.md) for the rule-by-rule mapping.

Highlights:

- VPC flow logs to CloudWatch
- All inbound SGs scoped to ALB SG (no `0.0.0.0/0` except ALB:443 and, when enabled, NLB:8443 for SP3)
- IMDSv2-only on Fargate
- Aurora encryption at rest, deletion protection (prod), automated backups, IAM database authentication
- ElastiCache encryption at rest and in transit, auth token in Secrets Manager
- S3 buckets: block public access, default encryption, versioning, secure-transport policy, object-ownership = bucket-owner-enforced
- ALB: TLS 1.3 default policy, HTTP-to-HTTPS redirect, access logs, drop_invalid_header_fields
- WAFv2: AWS Managed Common Rule Set + Known Bad Inputs + SQLi + rate limiting, associated to ALB
- Secrets Manager with AWS-managed KMS
- IAM: per-service execution + task roles, no wildcards, no `*:*`
- Readonly root filesystem on every Fargate task

## Local development workflow

- `npm run typecheck` - strict TS check
- `npm run lint` / `npm run lint:fix`
- `npm run synth -- --context env=<env>` - render CFN templates to `cdk.out/`
- `npm run diff -- --context env=<env>` - show pending changes vs deployed
- `npm run deploy -- --context env=<env> Evtivity-<Env>-Ecs` - target a single stack
- `npm run deploy -- --context env=<env> --all`
- `npm run destroy -- --context env=<env> --all`

Commits are conventional (`feat:`, `fix:`, `docs:`, `chore:`, ...) - the husky `commit-msg` hook runs `commitlint` on every commit. Same convention as the CSMS repo.

## CI

`.github/workflows/ci.yml` runs on every PR: install, typecheck, lint, and `cdk synth` for all three envs. Uses the committed `cdk.context.json` to satisfy AZ and hosted-zone lookups without AWS credentials.

`.github/workflows/deploy.yml` is `workflow_dispatch`-triggered. Pick env (dev/qa/prod) and an optional stack pattern, authenticate to AWS via OIDC, deploy. Prod is gated by a required-reviewers GitHub environment.

## License

[BSL 1.1](LICENSE.md). The Change License is Apache 2.0 effective four years after each release.
