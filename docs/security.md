# Security posture

The stacks are built to pass the AWS Foundational Security Best Practices (FSBP) controls that apply to the resources they create. Compliance is scoped to these stacks. Account-level services (Security Hub, AWS Config, CloudTrail, GuardDuty, IAM password policy, account-wide EBS default encryption) are out of scope and belong at the AWS Organization or account baseline.

Three checks run on every change:

1. **cdk-nag** (AWS Solutions pack) runs on every `cdk synth`. An unacknowledged finding fails the synth. Every acknowledgement lives in `lib/nag-suppressions.ts` with its reason.
2. **Compliance tests** (`npm test`) synthesize dev, qa, and prod and assert the FSBP controls listed below, plus the accepted gaps, so a fixed or widened exception fails the build.
3. **Exception register** (`docs/compliance-exceptions.md`) documents every control a stack does not meet, with compensating controls and a review date.

## Encryption

| Resource           | At rest                                | In transit                                                 |
| ------------------ | -------------------------------------- | ---------------------------------------------------------- |
| Aurora PostgreSQL  | AWS-managed key (`aws/rds`)            | `rds.force_ssl=1`: the cluster rejects unencrypted clients |
| ElastiCache Valkey | AWS-managed key                        | `TransitEncryptionMode: required`                          |
| S3 buckets         | SSE-S3                                 | Bucket policy denies requests without TLS, minimum TLS 1.2 |
| Secrets Manager    | AWS-managed key (`aws/secretsmanager`) | TLS API endpoint                                           |
| SNS alarm topic    | Customer-managed key, yearly rotation  | Topic policy denies publishes without TLS                  |
| NAT instance (EBS) | Encrypted root volume                  | n/a                                                        |
| ALB listeners      | n/a                                    | `ELBSecurityPolicy-TLS13-1-2-Res-2021-06`, HTTP redirects  |
| ALB to containers  | n/a                                    | HTTP inside the VPC (EXC-001)                              |

The only customer-managed KMS key encrypts the alerts topic. CloudWatch alarms and EventBridge rules cannot publish to a topic encrypted with `aws/sns`, so the key policy grants them `kms:GenerateDataKey` and `kms:Decrypt`.

## Credentials

| Secret                                   | Used by                            | Rotation                                                               |
| ---------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------- |
| `evtivity/<env>/db-master`               | Database job only                  | Single-user, every `rotation.databaseDays` (AWS hosted function)       |
| `evtivity/<env>/db-app`                  | Every service                      | Multi-user alternating (`evtivity_app` / `evtivity_app_clone`)         |
| `evtivity/<env>/cache-app`               | Every service                      | Custom function keeps current and pending passwords on the Valkey user |
| `evtivity/<env>/jwt`                     | API                                | Static (EXC-003)                                                       |
| `evtivity/<env>/settings-encryption-key` | API, OCPP, OCPI, worker, demo seed | Static (EXC-003)                                                       |
| `evtivity/<env>/initial-admin`           | Database job                       | Static; the admin must change the password at first sign-in (EXC-003)  |
| `evtivity/<env>/grafana-admin`           | Grafana                            | Static (EXC-003)                                                       |

How rotated credentials reach running tasks:

- ECS reads secrets only when a task starts. The services receive `DB_*` and `REDIS_*` fields, and the image entrypoint builds `DATABASE_URL` and `REDIS_URL` from them.
- Both rotation schemes keep the previous credential valid for one full interval: the database alternates between two roles, and the Valkey user holds two passwords.
- An EventBridge Scheduler job forces a new deployment of each service every `ecs.redeployEveryDays` days (weekly by default). The config schema rejects a redeploy interval that is not shorter than the rotation interval.
- The Valkey user may run everything the services need but no admin or dangerous commands (`on ~* &* +@all -@dangerous +info`). Changing its access string updates the user, which resets its passwords to the current secret, so redeploy the services after such a change.
- With `secrets.removal: retain` (prod), every credential secret survives a stack delete, including the database and cache users, so a rebuild on the retained snapshot keeps working credentials. Their names are fixed, so a rebuilt Data stack must import them or they must be deleted first.
- Application privileges belong to the `evtivity_app_group` role. The database job creates it and grants default privileges for tables that migrations create, and the rotation copies the group membership to the clone role. Migrations run as the cluster owner, so every table has one owner.

## Network

- Public, private, and isolated subnet tiers. Aurora and Valkey live in isolated subnets with no route to the internet.
- Tasks run in private subnets with no public IP. Outbound traffic goes through fck-nat (dev, qa) or NAT gateways (prod).
- Security groups:
  - ALB: 443 and 80 from anywhere. Egress only to the tasks' service and health ports.
  - Tasks: ingress from the ALB on service and health ports, and from other tasks on internal ports (Cloud Map).
  - Aurora: 5432 from tasks and rotation functions only. Valkey: 6379 from the same.
  - OCPP TLS NLB (optional): the TLS port from anywhere (EXC-006).
- Grafana, Loki, Prometheus, and the log forwarder use their own security group. Only the app services' group can reach Aurora (5432) and Valkey (6379), so Grafana, which is reachable through the ALB, has no network path to the data stores.
- The VPC default security group has every rule removed. VPC flow logs capture all traffic and go to the logs bucket as Parquet under `vpc-flow-logs/`. The bucket's expiration (`storage.logsExpirationDays`) sets their retention.
- The S3 gateway endpoint keeps bucket traffic off the NAT. Interface endpoints are optional per environment.

## Compute

- Fargate on ARM64, platform version `LATEST`, deployment circuit breaker with rollback.
- Every container: read-only root filesystem with scratch volumes, not privileged, `initProcessEnabled`, awslogs logging, secrets only through the `secrets` field.
- Every container runs as a non-root user: Node services as uid 1000, the csms and portal nginx images as uid 101.
- Container Insights is on for the cluster. ECS Exec is on in dev and qa only (`ecs.executeCommand`). Each container keeps its read-only root filesystem: the SSM agent writes to two scratch volumes at `/var/lib/amazon` and `/var/log/amazon`. AWS does not officially support ECS Exec with a read-only root filesystem, and this layout was verified on Fargate. Sessions run as root inside the container and are logged to the `/evtivity/<env>/ecs-exec` log group.
- The NAT instance enforces IMDSv2 through the `@aws-cdk/aws-ec2:requireImdsv2` flag.

## Load balancing and WAF

- ALB drops invalid header fields, uses defensive desync mitigation, and writes access logs to the logs bucket.
- Deletion protection is on in prod.
- Every environment with observability gets a web ACL that limits Grafana to the allowlist. In qa and prod (`waf.enabled`) it also runs the AWS managed IP reputation, common, known bad inputs, and SQL injection rule groups, a per-IP rate limit, and an optional country block. `NoUserAgent_HEADER` and `SizeRestrictions_BODY` run in count mode because charging stations often omit a User-Agent and bulk imports exceed 8 KB. WAF logs go to CloudWatch with the `authorization` and `cookie` headers redacted.

## FSBP controls asserted by the tests

| Control                                      | How the stacks meet it                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| S3.1, S3.8                                   | Block Public Access on every bucket                                                                                      |
| S3.5                                         | TLS-only bucket policy                                                                                                   |
| S3.9                                         | App bucket access logs go to the logs bucket                                                                             |
| S3.12                                        | ACLs disabled (BucketOwnerEnforced)                                                                                      |
| S3.13                                        | Lifecycle rules on every bucket                                                                                          |
| RDS.2, RDS.9, RDS.12, RDS.16, RDS.27, RDS.35 | Private instances, PostgreSQL log export, IAM auth, tags copied to snapshots, storage encryption, minor version upgrades |
| RDS.6                                        | Enhanced monitoring on every instance                                                                                    |
| RDS.7, RDS.15                                | Prod only: deletion protection, writer and reader across AZs (EXC-004 for dev and qa)                                    |
| RDS.24                                       | Master username is `evtivity_admin`, not the engine default                                                              |
| ElastiCache.1, .2, .4, .5, .7                | Automatic backups, minor version upgrades, encryption at rest and in transit, custom subnet group                        |
| ElastiCache.3                                | Prod only: automatic failover (EXC-004 for dev and qa)                                                                   |
| ECS.2, ECS.4, ECS.5, ECS.8, ECS.9, ECS.12    | No public IPs, not privileged, read-only root, no secrets in environment variables, logging, Container Insights          |
| ECS.20                                       | Node services run as uid 1000, csms and portal as uid 101                                                                |
| ELB.1, ELB.4, ELB.5, ELB.6                   | HTTP redirects to HTTPS, invalid headers dropped, access logs, prod deletion protection                                  |
| WAF.11                                       | Web ACL logging where WAF is enabled                                                                                     |
| EC2.2, EC2.6                                 | Default security group restricted, VPC flow logs                                                                         |
| EC2.15                                       | Subnets do not assign public IPs on launch                                                                               |
| SecretsManager.1                             | Database and cache credentials rotate (EXC-003 for the static keys)                                                      |
| Lambda.1, Lambda.2                           | No public invoke permissions, current Node.js runtime                                                                    |

## Observability

- Grafana, Loki, and Prometheus run as their images' non-root users (472, 10001, 65534) with read-only root filesystems. Grafana's provisioner runs as the Grafana user too.
- Loki and Grafana state lives on an encrypted EFS file system with automatic backups (EFS.1, EFS.2). Each service mounts its own access point, which forces its POSIX user and root directory (EFS.3, EFS.4). Mounts use TLS and IAM authorization.
- Grafana is public only for `observability.grafana.allowedCidrs`, behind the ALB (and WAF where enabled), with anonymous access and sign-up disabled.
- Grafana reads Amazon Managed Service for Prometheus and publishes alerts to SNS through its task role. No AWS keys are stored.
- Loki has its own bucket, so it cannot modify the Grafana provisioning files.

## Tags

Every taggable resource carries `Environment`, `Service`, `Stack`, `Project`, `ManagedBy`, `Repository`, `CreatedDate`, and `UpdatedDate`. `CreatedDate` comes from the environment config and never changes. `UpdatedDate` is the day of the synth. ECS task definitions, the NAT launch template, Aurora, and Valkey skip `UpdatedDate`: a changed tag would restart every service, replace the NAT instance, or put the database and cache into a modifying state on every deploy. Resources that AWS creates at run time (Lambda log groups of the hosted rotation functions, network interfaces) and resource types without tag support in CloudFormation (security group rules, routes, record sets, schedules) are not tagged.
