# Security posture

This stack is designed to satisfy the high-impact controls in **AWS Foundational Security Best Practices** and **CIS AWS Foundations Benchmark v3.0** without requiring AWS Security Hub itself to be enabled. If you turn Security Hub on later, the stack should pass the corresponding controls without modification.

## Encryption

| Resource | At rest | In transit |
|---|---|---|
| Aurora PostgreSQL | AES-256 with AWS-managed key (alias `aws/rds`) | TLS required on the cluster endpoint |
| ElastiCache Redis | AES-256 with AWS-managed key | TLS (`transitEncryptionEnabled: true`) plus AUTH token |
| S3 buckets | SSE-S3 (AWS-managed) | `aws:SecureTransport` policy denies non-TLS requests |
| Secrets Manager | AWS-managed key (`aws/secretsmanager`) | TLS via API endpoint |
| CloudWatch Logs | AWS-managed key | TLS via API endpoint |

The CDK does not provision customer-managed KMS keys. If you later need stricter key control, swap encryption keys to CMKs on individual constructs.

## Network

- VPC has public, private-with-egress, and isolated subnet tiers
- Security groups follow least-access:
  - ALB SG: 80/443 from `0.0.0.0/0`
  - ECS SG: ingress only from ALB SG, on the specific container port per service
  - Aurora SG: 5432 from ECS SG only
  - Redis SG: 6379 from ECS SG only
- VPC default security group has all rules removed (`restrictDefaultSecurityGroup: true`)
- VPC flow logs enabled to CloudWatch
- VPC endpoints for S3 (gateway) and Secrets Manager / SSM / CloudWatch Logs / ECR (interface) so AWS API traffic stays inside the VPC where possible
- Aurora and Redis run in isolated subnets with no NAT route

## Compute

- ECS Fargate platform version `LATEST`
- Task definitions use ARM64 / Linux
- Container `readonlyRootFilesystem: true` by default (toggle per service via config if a service needs writable temp space)
- IMDSv2 is enforced for any EC2 instances via context flag (`@aws-cdk/aws-ec2:requireImdsv2`)
- Container Insights v2 (Enhanced) on the ECS cluster
- Service deployment circuit breaker with rollback enabled

## Application Load Balancer

- Listener: HTTPS only with TLS 1.3 default policy (`SslPolicy.TLS13_RES`)
- HTTP listener exists only to redirect to HTTPS with a 301
- `dropInvalidHeaderFields: true` (FSBP `ELB.4`)
- Access logs to a dedicated S3 bucket with lifecycle expiration
- Deletion protection enabled in prod
- WAFv2 web ACL associated with:
  - AWS Managed: Common Rule Set
  - AWS Managed: Known Bad Inputs
  - AWS Managed: SQL Injection
  - Rate-based rule (configurable per env)
  - Optional geo block list

## Database

- Aurora deletion protection enabled in prod
- Backup retention: 1 day (dev), 3 days (qa), 14 days (prod)
- IAM database authentication enabled
- Automated minor version upgrades enabled
- Postgres logs exported to CloudWatch
- Performance Insights enabled in prod
- Master credentials managed by RDS in Secrets Manager (auto-generated, rotatable)

## Cache

- Redis transit encryption with AUTH token (auto-generated, stored in Secrets Manager)
- Redis at-rest encryption
- Multi-AZ + automatic failover in prod
- Snapshot retention configurable per env

## Secrets

- All secrets in AWS Secrets Manager with paths `evtivity/<env>/<name>`
- ECS tasks access secrets via task execution role; only the specific secret ARNs are granted, never `*`
- Application code reads secrets from the env vars injected by ECS (no SDK calls at runtime)

## IAM

- One execution role per service (ECS task execution role for Secrets Manager / CloudWatch Logs / ECR pull)
- One task role per service (extend per service for S3, SES, etc.)
- No wildcards (`Action: "*"` or `Resource: "*"` outside Secrets Manager logical scope) — CDK `@aws-cdk/aws-iam:minimizePolicies` flag is on
- No long-lived access keys; deploy uses GitHub OIDC short-lived role assumption

## Defaults that satisfy specific controls

| SH control | How this stack satisfies it |
|---|---|
| **EC2.6** VPC flow logging enabled in all VPCs | `FlowLog` to CloudWatch in every VPC |
| **EC2.2** Default SG should not allow inbound/outbound | `restrictDefaultSecurityGroup: true` |
| **EC2.8** EC2 instances should use IMDSv2 | Context flag `@aws-cdk/aws-ec2:requireImdsv2` |
| **RDS.3** RDS encryption at rest | `storageEncrypted: true` on Aurora cluster |
| **RDS.13** Automatic minor version upgrades | Configurable, default true |
| **RDS.7** Deletion protection enabled | Required true in `prod.yaml` |
| **ELB.1** HTTP requests should redirect to HTTPS | HTTP listener returns 301 to HTTPS |
| **ELB.4** ALB should drop HTTP headers | `dropInvalidHeaderFields: true` |
| **ELB.5** ALB logging enabled | `logAccessLogs(...)` |
| **ELB.6** ALB deletion protection | Required true in `prod.yaml` |
| **WAF.10** Web ACL should be in use | WAFv2 ACL associated to ALB |
| **S3.1** Block all public access (account level) | `BlockPublicAccess.BLOCK_ALL` per bucket |
| **S3.5** S3 buckets require TLS | `enforceSSL: true` |
| **S3.4** Server-side encryption | `BucketEncryption.S3_MANAGED` |
| **S3.14** Versioning enabled | `versioned: true` |
| **ElastiCache.3** Automatic failover | Configurable; required true in prod |
| **ElastiCache.4** Redis encryption at rest | `atRestEncryptionEnabled: true` |
| **ElastiCache.5** Redis encryption in transit | `transitEncryptionEnabled: true` |
| **ElastiCache.6** Redis AUTH token | `authToken` from Secrets Manager |
| **ECS.1** Task definition should not pass secrets via plain env | All secrets injected via `secrets:` (Secrets Manager / SSM) |
| **ECS.5** Container should be read-only root | `readonlyRootFilesystem: true` default |
| **SecretsManager.1** Secrets should be rotated automatically | (manual rotation; flip on per secret as needed) |
| **IAM.1** No `*:*` policies | Service-specific roles, no wildcards |

## Things this stack does NOT do (by design)

- **GuardDuty, CloudTrail org-level, Security Hub, AWS Config** — explicitly out of scope per project decision. Add them at the AWS Organization root if you want them.
- **AWS Shield Advanced** — not provisioned. Default Shield Standard applies.
- **VPC peering / Transit Gateway** — single-VPC design.
- **Customer-managed KMS keys** — AWS-managed keys are used everywhere. Easy to swap if your compliance team requires CMKs.
- **PCI DSS specific controls** — payment card data is handled by Stripe; the CSMS only stores tokenized handles.
- **Backup vaults** — RDS automated backups + S3 versioning are sufficient for the failure modes covered. Add AWS Backup if you need cross-service backup orchestration.
