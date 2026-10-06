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

| Secret                                   | Used by                                     | Rotation                                                               |
| ---------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------- |
| `evtivity/<env>/db-master`               | Database job only                           | Single-user, every `rotation.databaseDays` (AWS hosted function)       |
| `evtivity/<env>/db-app`                  | Every service                               | Multi-user alternating (`evtivity_app` / `evtivity_app_clone`)         |
| `evtivity/<env>/cache-<service>`         | That service (api, ocpp, ocpi, worker, css) | Custom function keeps current and pending passwords on the Valkey user |
| `evtivity/<env>/jwt`                     | API                                         | Static (EXC-003)                                                       |
| `evtivity/<env>/settings-encryption-key` | API, OCPP, OCPI, worker, demo seed          | Static (EXC-003)                                                       |
| `evtivity/<env>/initial-admin`           | Database job                                | Static; the admin must change the password at first sign-in (EXC-003)  |
| `evtivity/<env>/grafana-admin`           | Grafana                                     | Static (EXC-003)                                                       |

How rotated credentials reach running tasks:

- ECS reads secrets only when a task starts. The services receive `DB_*` and `REDIS_*` fields, and the image entrypoint builds `DATABASE_URL` and `REDIS_URL` from them.
- Both rotation schemes keep the previous credential valid for one full interval: the database alternates between two roles, and the Valkey user holds two passwords.
- An EventBridge Scheduler job forces a new deployment of each service every `ecs.redeployEveryDays` days (weekly by default). The config schema rejects a redeploy interval that is not shorter than the rotation interval.
- Each service connects to Valkey as its own user. `config/redis-acl-rules.conf` (a copy of the CSMS repo's `docker/redis/acl-rules.conf`) sets its keys, pub/sub channels, and commands: only the worker reaches the BullMQ queues, only OCPP the station connection registry, and the simulator and OCPI cannot publish what they do not own (the simulator cannot publish `ocpp_commands`). No user may run admin or dangerous commands (`-@dangerous +info`). Changing an access string updates the user, which resets its passwords to the current secret, so redeploy the services after such a change.
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
- Grafana and Prometheus use their own security group. Only the app services' group can reach Aurora (5432) and Valkey (6379), so Grafana, which is reachable through the ALB, has no network path to the data stores.
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
- Every environment with observability gets a web ACL that limits Grafana to its allowlist. In qa and prod (`waf.enabled`) the same web ACL runs the rules in [WAF rules](#waf-rules).
- WAF logs go to CloudWatch (`aws-waf-logs-evtivity-<env>`) with the `authorization` and `cookie` headers redacted.

## WAF rules

The web ACL is attached to the public ALB and covers every host on it (api, ocpp, ocpi, csms, portal, grafana). It does not cover the OCPP TLS network load balancer, which passes TLS straight to the OCPP service. Rules run in priority order. The first `Allow` or `Block` ends evaluation. Requests that match nothing are allowed.

| Priority | Rule                    | Action       | What it does                                                                                                           |
| -------- | ----------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| 1        | `GrafanaAllowList`      | Block        | Blocks the Grafana host for addresses outside the Grafana IP set. Present whenever observability is on, including dev. |
| 2        | `StripeWebhookAllow`    | Allow        | Lets requests to `/v1/webhooks/payments/stripe` from Stripe's webhook addresses skip every later rule.                 |
| 3        | `OcppWebSocketOnly`     | Block        | Blocks requests to the OCPP host without an `Upgrade: websocket` header. Stations only open WebSockets.                |
| 4        | `StaticSiteMethods`     | Block        | Blocks methods other than GET and HEAD on the csms and portal hosts. Both are static sites with no API behind them.    |
| 5        | `GeoAllow`              | Block        | Blocks countries outside `waf.allowCountries` (default `[US]`). The OCPP host and the Adyen webhook POST are exempt.   |
| 10       | IP reputation list      | Block        | AWS list of addresses tied to bots, scanning, and malware. The OCPP host is exempt.                                    |
| 15       | Anonymous IP list       | Block, count | Blocks VPNs and Tor. Hosting provider addresses only count. The OCPP host is exempt.                                   |
| 20       | Core rule set           | Block, count | OWASP-style protections: cross-site scripting, path traversal, SSRF to instance metadata, oversized requests.          |
| 30       | Known bad inputs        | Block        | Exploit patterns such as Log4j and Java deserialization.                                                               |
| 40       | SQL database            | Block        | SQL injection in the query string, body, cookies, and URI path.                                                        |
| 50       | Linux operating system  | Block        | Local file inclusion of Linux paths such as `/etc/passwd` and `/proc/self/environ`.                                    |
| 100      | `RateLimitPerIp`        | Block        | More than `waf.rateLimitPer5Min` (2000) requests per IP in 5 minutes, on every host except OCPP.                       |
| 101      | `OcppRateLimitPerIp`    | Block        | More than `waf.ocppRateLimitPer5Min` (20000) OCPP connection attempts per IP in 5 minutes.                             |
| 102      | `AuthRateLimitPerIp`    | Block        | More than `waf.authRateLimitPer5Min` (50) POSTs per IP in 5 minutes to `/v1/auth/*` and `/v1/portal/auth/*`.           |
| 103      | `GuestRateLimitPerIp`   | Block        | More than `waf.guestRateLimitPer5Min` (100) POSTs per IP in 5 minutes to `/v1/portal/guest/*`.                         |
| 104      | `AdyenWebhookRateLimit` | Block        | More than `waf.adyenWebhookRateLimitPer5Min` (1000) POSTs per IP in 5 minutes to `/v1/webhooks/payments/adyen`.        |

Rules 10 through 50 are AWS managed rule groups with no subscription fee. Rules that name a host or path only exist when that service is enabled.

### Why the rules look like this

- **Count-mode rules.** In the core rule set, `NoUserAgent_HEADER` and `SizeRestrictions_BODY` count instead of block (`waf.countRules`). Charging stations often send no User-Agent, and site and token imports exceed 8 KB. In the anonymous IP list, `HostingProviderIPList` counts because Stripe, OCPI partners, and IoT SIM gateways run on cloud providers.
- **Charging stations.** Stations on cellular networks often share one public address through carrier NAT, and roaming IoT SIMs can exit in another country. Blocking one address could take a whole fleet offline, and a mass reconnect after an outage would trip the global rate limit. So the OCPP host skips the country, IP reputation, anonymous IP, and global rate rules, and gets a separate, higher limit. A WebSocket counts as one request when it opens. Messages inside it do not count. Station authentication in the OCPP service is the gate.
- **Stripe webhooks.** Stripe sends webhooks from addresses in the US, Germany, and India, so the country rule would block some of them. Content rules could also block a payload that happens to contain an attack pattern. The allow rule matches only the webhook path and only Stripe's published addresses. The API still verifies the `Stripe-Signature` header against the platform and Connect endpoint secrets.
- **Adyen webhooks.** Adyen publishes no webhook IP ranges, advises against IP allowlists, and sends from its own data centers (in the EU for most accounts), so the country rule would block it. `GeoAllow` exempts only a POST to exactly `/v1/webhooks/payments/adyen` on the API host. Every other rule still applies, and `AdyenWebhookRateLimit` bounds the exempt path. The API checks the Basic auth credentials and the HMAC signature of every event before it reads them. A request the content rules block gets a 403, and Adyen retries it for up to 30 days.
- **Auth and guest limits.** The API's own per-IP limits see the load balancer's address, not the client's, so these WAF limits are the only per-client limits on sign-in and guest charging. They count POSTs only. Token refresh and logout are excluded because every signed-in session calls them. Guest status polling uses GET and is excluded.
- **Paths.** Path matches URL-decode and normalize the path first, so `/v1//auth/login` or `%2F` cannot dodge a rule. Host matches use `STARTS_WITH` so a port or trailing dot in the Host header still matches.

### Limits

- On an ALB the WAF inspects only the first 8 KB of a request body, and the limit cannot be raised. Content in larger bodies, such as bulk imports, is not checked. Parameterized queries in the application are the primary SQL injection defense.
- The web ACL uses 1,494 of the 1,500 capacity units (WCU) included in the base price, measured with the WAF `CheckCapacity` API. Adding another managed rule group exceeds that and adds cost.
- Clients that share an address, such as an office or a mobile carrier's NAT, share every per-IP limit.
- Grafana users must also be in an allowed country.
- OCPI partners outside the allowed countries are blocked. Add their countries to `waf.allowCountries`.
- Not enabled: Bot Control, account takeover prevention, account creation fraud prevention, and the anti-DDoS rule group (all paid per request), and the admin protection group (the whole CSMS is an admin app). AWS Shield Standard protects the ALB from network-layer floods at no charge.

### Operating the WAF

Stripe publishes its webhook addresses at <https://stripe.com/files/ips/ips_webhooks.json> and announces changes seven days ahead on its [API announce list](https://groups.google.com/a/lists.stripe.com/g/api-announce). Sync the IP set without a deploy:

```bash
AWS_PROFILE=<name> ./scripts/stripe-webhook-ips.sh prod diff   # compare with Stripe's list
AWS_PROFILE=<name> ./scripts/stripe-webhook-ips.sh prod sync   # replace the set with Stripe's list
AWS_PROFILE=<name> ./scripts/stripe-webhook-ips.sh prod list
```

`waf.stripeWebhookIps` only seeds the set. Changing it replaces the set's contents on the next deploy, so update it after a sync.

To see what the WAF blocked, query the WAF log group in CloudWatch Logs Insights:

```
fields @timestamp, httpRequest.clientIp, httpRequest.country, httpRequest.host, httpRequest.uri, terminatingRuleId
| filter action = "BLOCK"
| sort @timestamp desc
| limit 100
```

Each rule also publishes CloudWatch metrics (`AWS/WAFV2`, one metric name per rule) with sampled requests in the WAF console.

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

- Grafana and Prometheus run as their images' non-root users (472, 65534) with read-only root filesystems. Grafana's provisioner runs as the Grafana user too.
- Grafana's database lives on an encrypted EFS file system with automatic backups (EFS.1, EFS.2). Grafana mounts its own access point, which forces its POSIX user and root directory (EFS.3, EFS.4). Mounts use TLS and IAM authorization.
- Grafana is public only for `observability.grafana.allowedCidrs`, behind the ALB (and WAF where enabled), with anonymous access and sign-up disabled.
- Grafana reads Amazon Managed Service for Prometheus, runs Logs Insights queries on the environment's log groups only, reads CloudWatch metrics (`ListMetrics`, `GetMetricData`, read-only), and publishes alerts to SNS, all through its task role. No AWS keys are stored.

## Tags

Every taggable resource carries `Environment`, `Service`, `Stack`, `Project`, `ManagedBy`, `Repository`, `CreatedDate`, and `UpdatedDate`. `CreatedDate` comes from the environment config and never changes. `UpdatedDate` is the day of the synth. ECS task definitions, the NAT launch template, Aurora, and Valkey skip `UpdatedDate`: a changed tag would restart every service, replace the NAT instance, or put the database and cache into a modifying state on every deploy. Resources that AWS creates at run time (Lambda log groups of the hosted rotation functions, network interfaces) and resource types without tag support in CloudFormation (security group rules, routes, record sets, schedules) are not tagged.
