# Compliance Exception Register

Scope: the EVtivity CSMS CDK stacks (`Evtivity-<Env>-*`). Account-level services (Security Hub, AWS Config, CloudTrail, GuardDuty) are out of scope for this repository. Controls are referenced by their AWS Security Hub control ID (AWS Foundational Security Best Practices v1.0.0) for traceability, and are checked by the CDK compliance tests at synth time.

Each exception lists the control, the affected resources and environments, why the control is not met, the compensating controls that are in place, and the plan and date to close it. Review every open exception at least quarterly and on each release.

| ID      | Control                                                          | Status          | Opened     | Review by  |
| ------- | ---------------------------------------------------------------- | --------------- | ---------- | ---------- |
| EXC-001 | ELB.21, ELB.22 (TLS from load balancer to targets)               | Open, temporary | 2026-09-27 | 2026-12-27 |
| EXC-002 | ECS.20 (containers run as a non-root user), csms and portal only | Closed          | 2026-09-27 | n/a        |
| EXC-003 | SecretsManager.1, SecretsManager.4 (static application keys)     | Open, accepted  | 2026-09-27 | 2026-12-27 |
| EXC-004 | RDS.7, RDS.15, ElastiCache.3, ELB.6 in lower environments        | Open, accepted  | 2026-09-27 | 2026-12-27 |
| EXC-005 | EC2.9 (NAT instance public IP) in lower environments             | Open, accepted  | 2026-09-27 | 2026-12-27 |
| EXC-006 | EC2.18, EC2.19 (OCPP TLS port open to the internet)              | Open, accepted  | 2026-09-27 | 2026-12-27 |
| EXC-007 | ELB.1 (plain WebSocket listener for OCPP), opt-in only           | Open, accepted  | 2026-09-27 | 2026-12-27 |

## EXC-001: TLS between the load balancer and the containers

**Controls:**

- ELB.21: Application and Network Load Balancer target groups should use encrypted health check protocols.
- ELB.22: ELB target groups should use encrypted transport protocols.

**Affected resources:** the ALB target groups for api, ocpp, ocpi, csms, and portal, in all environments (dev, qa, prod).

**Why it is not met:** TLS terminates at the ALB, which forwards HTTP to the containers. The published images (up to 0.1.19) only serve plain HTTP. Serving HTTPS inside each container requires an application release.

**Compensating controls:**

- Client traffic is encrypted end to end to the ALB. The HTTPS listener uses `ELBSecurityPolicy-TLS13-1-2-Res-2021-06` (TLS 1.2 minimum), and the HTTP listener only redirects to HTTPS.
- Containers run in private subnets with no public IP (ECS.2). The only inbound path is from the ALB security group, on the container port only. No other source can reach the targets.
- Traffic between the ALB and the targets never leaves the VPC. VPC flow logs record all traffic in the VPC.
- AWS WAF inspects requests at the ALB before they reach any target.
- Charging stations using security profile 3 connect through the NLB with TCP passthrough, so their mutual TLS terminates inside the OCPP container.

**Risk:** an attacker who already has code execution inside the VPC could observe plaintext requests between the ALB and the targets. That requires breaching the network boundary controls listed above first.

**Remediation plan:** ship an application release in which api, ocpp, ocpi, csms, and portal serve HTTPS on their container ports. Each uses a certificate generated at container start (the ALB does not validate target certificates). Then switch the target groups and health checks to HTTPS through config (`services.<name>.targetProtocol: HTTPS`).

**Closes when:** a release with in-container TLS is deployed to prod and the compliance tests assert HTTPS target groups in all environments.

## EXC-002: csms and portal containers run as root (closed)

**Control:** ECS.20: ECS task definitions should configure non-root users in Linux container definitions.

**Resolution:** CSMS 0.1.22 builds csms and portal on `nginxinc/nginx-unprivileged:alpine`. The task definitions run them as uid 101 with a read-only root filesystem and one writable `/tmp` volume. The compliance tests assert a non-root `user` on every container definition in every environment.

## EXC-003: static application keys

**Controls:** SecretsManager.1 (automatic rotation enabled) and SecretsManager.4 (rotated within the configured period).

**Affected resources:** `evtivity/<env>/jwt`, `evtivity/<env>/settings-encryption-key`, `evtivity/<env>/initial-admin`, and `evtivity/<env>/grafana-admin` (when observability is enabled), in all environments. The database and cache credentials rotate and are not part of this exception.

**Why it is not met:**

- The JWT key signs access and refresh tokens and cookies. The API verifies against one key, so rotating it signs out every operator and driver at once.
- The settings encryption key encrypts every `*Enc` setting (Stripe, SMTP, Twilio, S3, and other credentials) with AES-256-GCM. Rotating it without re-encrypting those rows makes them unreadable. The application has no re-encryption path yet.
- Grafana reads its admin password from the environment only when its database is first created. After that the password lives in the Grafana database, so rotating the secret would not change the working password. Operators change it in Grafana.
- The initial admin secret is used once. The seeded user must change the password at first sign-in, after which the secret no longer grants access.

**Compensating controls:**

- The secrets are generated inside Secrets Manager (64 random characters) and never appear in templates, config, or logs.
- Only the task execution roles of the services that need each key can read it. ECS injects it at task start.
- CloudTrail (account level) records every read of the secret values.
- In prod the secrets are retained when the stacks are deleted, so a rebuild keeps encrypted settings readable.

**Remediation plan:** accept a list of JWT verification keys in the API (sign with the newest, verify with any), then rotate the JWT key on a schedule. Add a re-encryption job for `*Enc` settings, then rotate the settings key.

## EXC-004: availability and deletion protection in lower environments

**Controls:** RDS.7 (cluster deletion protection), RDS.15 (clusters across multiple AZs), ElastiCache.3 (automatic failover), ELB.6 (load balancer deletion protection).

**Affected resources:** the Aurora cluster, the Valkey replication group, and the ALB in dev and qa. Prod meets all four controls, and the compliance tests assert it.

**Why it is not met:** dev and qa hold test data only, and are built and torn down on demand. A single Aurora instance, a single Valkey node, and no deletion protection keep their cost low and let `cdk destroy` remove them.

**Compensating controls:**

- Each setting is a config value (`aurora.readers`, `aurora.deletionProtection`, `valkey.replicas`, `alb.deletionProtection`). Prod sets them, and the prod compliance tests fail if they change.
- Aurora keeps automated backups in every environment. Qa takes a final snapshot on delete (`aurora.removal: snapshot`).
- Deleting a stack requires deploy permissions to the account, which only engineers hold.

**Closes when:** not planned. The exception is permanent for non-production environments.

## EXC-005: NAT instance with a public IP in lower environments

**Controls:** EC2.9 (instances should not have a public IPv4 address). SSM.1 (instances managed by Systems Manager) does not apply because the instance has no instance profile for SSM.

**Affected resources:** the fck-nat instance in dev and qa (`vpc.nat.mode: fck-nat`). Prod uses managed NAT gateways.

**Why it is not met:** a NAT instance must have a public address to forward traffic to the internet. fck-nat costs about $7 per month including its public IPv4 address, against about $33 per month plus $0.045 per GB for a NAT gateway.

**Compensating controls:**

- The security group accepts traffic from the VPC CIDR only. Nothing on the internet can open a connection to the instance.
- IMDSv2 is required, the root volume is encrypted, and the instance has no SSH key.
- The instance runs the published fck-nat AMI, pinned per region in config, and has no application code or credentials.

**Closes when:** not planned for dev and qa. Set `vpc.nat.mode: gateway` to remove the instance.

## EXC-006: OCPP TLS port open to the internet

**Controls:** EC2.18 (security groups allow unrestricted inbound traffic only on authorized ports) and EC2.19 (unrestricted access to high-risk ports).

**Affected resources:** the NLB security group, only when `ocppTls.enabled` is true (off by default in every environment).

**Why it is not met:** charging stations using security profile 3 connect from arbitrary public addresses on port 8443. EC2.18 authorizes only 80 and 443 unless the account-level control parameters list more ports.

**Compensating controls:**

- The NLB passes TCP through to the OCPP server, which requires mutual TLS for security profile 3 stations. A connection without a client certificate signed by the configured CA cannot authenticate.
- The OCPP server enforces per-IP connection and message rate limits, and sees the real station address (client IP preservation is on).
- Port 8443 is not on the EC2.19 high-risk port list.

**Closes when:** the account-level Security Hub parameter `authorizedTcpPorts` for EC2.18 includes the OCPP TLS port. That is an account setting, outside these stacks.

## EXC-007: plain WebSocket listener for OCPP

**Control:** ELB.1 (Application Load Balancer should redirect all HTTP requests to HTTPS).

**Affected resources:** the ALB HTTP listener, only when `alb.ocppPlainWs` is true (off by default in every environment).

**Why it is not met:** OCPP security profiles 0 and 1 use `ws://`. Some deployed charging stations support nothing else. The option adds one host-header rule on port 80 that forwards the OCPP hostname to the OCPP service. Every other request still redirects.

**Compensating controls:**

- The rule matches only the OCPP hostname. The dashboard, portal, API, and OCPI stay HTTPS-only.
- Security profile 1 stations still authenticate with a per-station password, and the OCPP server rate limits per IP.
- Operators can move stations to security profile 2 or 3 at any time, then turn the option off.

**Closes when:** every station on the environment uses security profile 2 or 3 and `alb.ocppPlainWs` is set to false.
