# EVtivity CSMS - AWS CDK

AWS CDK infrastructure for the EVtivity Charging Station Management System. Companion to `evtivity-csms-helm` (Kubernetes); this repo provisions the equivalent platform on AWS using ECS Fargate, Aurora PostgreSQL, ElastiCache Redis, ALB with WAF, and supporting services.

## Layout

```
evtivity-csms-cdk/
├── bin/app.ts              # CDK app entry, picks env from --context
├── lib/
│   ├── config/             # YAML loader + zod schema
│   ├── stacks/             # One stack per concern (network, data, ecs, ...)
│   └── constructs/         # Shared higher-order constructs (secure-bucket, etc.)
├── config/
│   ├── dev.yaml
│   ├── qa.yaml
│   └── prod.yaml
├── docs/
│   ├── deployment.md
│   └── security.md
├── .github/workflows/
│   ├── ci.yml              # typecheck + lint + cdk synth on PR
│   └── deploy.yml          # workflow_dispatch with env input
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

All in `us-east-1`, single AWS account.

## Quick start

Prerequisites:
- AWS account with credentials configured (e.g., `aws sso login`)
- Node.js 22+
- `npm install -g aws-cdk` (or use `npx`)

```bash
npm install
npm run typecheck
npm run cdk -- bootstrap aws://ACCOUNT_ID/us-east-1   # one-time per account/region
npm run synth -- --context env=dev                    # render templates
npm run deploy -- --context env=dev --all             # deploy all stacks
```

## Image source

ECS pulls container images from `ghcr.io/evtivity/*` (the public registry maintained by `evtivity-csms-private`). The CDK does not provision ECR. Image tags come from `config/{env}.yaml` -> `services.<name>.imageTag`.

## Security posture

This stack is designed to pass the high-impact rules in:

- AWS Foundational Security Best Practices
- CIS AWS Foundations Benchmark v3.0

Without enabling AWS Security Hub itself. See [`docs/security.md`](docs/security.md) for the rule-by-rule mapping.

Highlights:

- VPC flow logs to CloudWatch
- All inbound SGs scoped to ALB SG (no `0.0.0.0/0` except ALB:443)
- IMDSv2-only on Fargate
- RDS encryption at rest, deletion protection (prod), automated backups, IAM database authentication
- ElastiCache encryption at rest and in transit, auth token in Secrets Manager
- S3 buckets: block public access, default encryption, versioning, secure-transport policy
- ALB: TLS 1.3 default policy, HTTP-to-HTTPS redirect, access logs, drop_invalid_header_fields
- WAFv2: AWS Managed Common Rule Set + rate limiting, associated to ALB
- Secrets Manager with AWS-managed KMS, optional rotation
- IAM: per-service execution + task roles, no wildcards, no `*:*`

## License

[BSL 1.1](LICENSE.md). The Change License is Apache 2.0 effective four years after each release.
