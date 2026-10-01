# Cost report

Monthly estimates for the committed `dev`, `qa`, and `prod` configs in us-east-1, at 730 hours per month. Unit prices come from the AWS Price List API, pulled on 2026-09-27. Usage-driven lines (ACU average, log volume, requests, NAT data) are ranges, because they depend on traffic.

## Summary

| Environment | Monthly estimate | Main drivers                                                                                             |
| ----------- | ---------------- | -------------------------------------------------------------------------------------------------------- |
| dev         | $127 to $191     | Aurora (36 to 49%), ALB with IPv4 (24%), Fargate Spot (10 to 15%)                                        |
| qa          | $203 to $271     | Fargate (24 to 33%), Aurora (24 to 36%), ALB with IPv4 (15%)                                             |
| prod        | $607 to $969     | Aurora writer and reader (30 to 37%), Fargate (28 to 30%), Valkey HA (8 to 13%), NAT gateways (9 to 13%) |

Totals include observability (Prometheus and Grafana), which every environment enables. It adds $5 to $11 in dev (Fargate Spot) and $15 to $21 in qa and prod. The per-environment tables below list the platform without it.

Optional add-ons:

- OCPP TLS NLB (`ocppTls.enabled`): about $28 per month (NLB hours, one NLCU, two public IPv4 addresses).
- Dev scaled to zero (every `desiredCount: 0`, Aurora paused): about $45 per month (ALB, NAT instance, Valkey, secrets).

## Unit prices (us-east-1)

| Item                                          | Price                                                             |
| --------------------------------------------- | ----------------------------------------------------------------- |
| Fargate ARM64 vCPU                            | $0.03238 per vCPU-hour                                            |
| Fargate ARM64 memory                          | $0.00356 per GB-hour                                              |
| Fargate Spot                                  | Variable. Estimated at 70% off on-demand (AWS quotes "up to 70%") |
| Aurora PostgreSQL Serverless v2               | $0.12 per ACU-hour                                                |
| Aurora storage / I/O / extra backup           | $0.10 per GB-month / $0.20 per million I/O / $0.021 per GB-month  |
| ElastiCache Valkey cache.t4g.micro            | $0.0128 per node-hour (Redis OSS: $0.016)                         |
| ElastiCache Valkey cache.t4g.medium           | $0.052 per node-hour (Redis OSS: $0.065)                          |
| Application or Network Load Balancer          | $0.0225 per hour, plus $0.008 per LCU-hour                        |
| NAT gateway                                   | $0.045 per hour, plus $0.045 per GB processed                     |
| EC2 t4g.nano (fck-nat)                        | $0.0042 per hour                                                  |
| Public IPv4 address                           | $0.005 per hour ($3.65 per month)                                 |
| WAF                                           | $5 per web ACL, $1 per rule, $0.60 per million requests           |
| Secrets Manager                               | $0.40 per secret per month                                        |
| CloudWatch Logs ingestion (custom and vended) | $0.50 per GB (first 10 TB)                                        |
| CloudWatch metrics / alarms                   | $0.30 per metric-month (first 10,000) / $0.10 per alarm           |

## dev

| Line                                                                   | Monthly          |
| ---------------------------------------------------------------------- | ---------------- |
| Fargate Spot, 7 services (2.0 vCPU, 4.5 GB). On-demand would be $58.97 | $17.69           |
| Aurora Serverless v2, 0.5 to 1 ACU average                             | $43.80 to $87.60 |
| Aurora storage and I/O (under 10 GB, under 5 million I/O)              | $1 to $2         |
| Valkey cache.t4g.micro, single node                                    | $9.34            |
| ALB (hours plus 1 LCU)                                                 | $22.27           |
| ALB public IPv4 x 2                                                    | $7.30            |
| fck-nat: t4g.nano, 4 GB gp3, public IPv4                               | $7.04            |
| Secrets Manager x 6                                                    | $2.40            |
| Container Insights (about 60 metrics)                                  | $9 to $18        |
| CloudWatch Logs (2 to 6 GB)                                            | $1 to $3         |
| Cloud Map, Lambda, S3, other                                           | $1 to $3         |
| **Total**                                                              | **$122 to $180** |

## qa

| Line                                             | Monthly          |
| ------------------------------------------------ | ---------------- |
| Fargate on-demand, 6 services (2.0 vCPU, 4.5 GB) | $58.97           |
| Aurora Serverless v2, 0.5 to 1 ACU average       | $43.80 to $87.60 |
| Aurora storage and I/O                           | $1 to $3         |
| Valkey cache.t4g.micro, single node              | $9.34            |
| ALB (hours plus 1 LCU)                           | $22.27           |
| ALB public IPv4 x 2                              | $7.30            |
| fck-nat                                          | $7.04            |
| WAF (1 ACL, 14 rules, under 5 million requests)  | $19 to $22       |
| Secrets Manager x 6                              | $2.40            |
| Container Insights (about 55 metrics)            | $8.25 to $16.50  |
| CloudWatch alarms (about 22) and dashboard       | $5.20            |
| CloudWatch Logs (3 to 10 GB)                     | $2 to $5         |
| Cloud Map, Lambda, S3, other                     | $1 to $3         |
| **Total**                                        | **$188 to $250** |

## prod

| Line                                                                      | Monthly            |
| ------------------------------------------------------------------------- | ------------------ |
| Fargate on-demand baseline (6.0 vCPU, 12 GB), up to 1.5x when scaled out  | $173.01 to $259.51 |
| Aurora Serverless v2, writer and reader, 1 to 2 ACU average each          | $175.20 to $350.40 |
| Aurora storage, I/O, and backups beyond the free allocation (20 to 50 GB) | $5 to $20          |
| Valkey cache.t4g.medium x 2 (primary and replica)                         | $75.92             |
| ALB (hours plus 2 to 5 LCU)                                               | $28.11 to $45.62   |
| ALB public IPv4 x 2                                                       | $7.30              |
| NAT gateway x 2, 50 to 200 GB processed                                   | $67.95 to $74.70   |
| NAT gateway public IPv4 x 2                                               | $7.30              |
| WAF (1 ACL, 14 rules, 5 to 20 million requests)                           | $22 to $31         |
| Secrets Manager x 6                                                       | $2.40              |
| Container Insights (about 60 metrics)                                     | $9 to $18          |
| CloudWatch alarms (about 24) and dashboard                                | $5.40              |
| CloudWatch Logs (10 to 40 GB ingest, 365-day retention)                   | $8 to $30          |
| Cloud Map, Lambda, S3, data transfer, other                               | $5 to $20          |
| **Total**                                                                 | **$592 to $948**   |

## Observability (per environment)

| Line                                                                                                                                                        | Monthly                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Fargate: Prometheus 0.25 vCPU/0.5 GB, Grafana 0.25/0.5 GB (on-demand; dev on Spot about $4.33)                                                              | $14.42                         |
| Amazon Managed Service for Prometheus: first 40 million samples free, then $0.90 per 10 million (API metrics at a 60-second scrape stay near the free tier) | $0 to $4                       |
| EFS (Grafana database, under 1 GB, elastic throughput)                                                                                                      | $0.25 to $1                    |
| S3 for Grafana provisioning files                                                                                                                           | $0.05 to $0.25                 |
| Logs Insights queries from the Grafana logs dashboard ($0.005 per GB scanned)                                                                               | $0 to $1                       |
| Secrets Manager (Grafana admin)                                                                                                                             | $0.40                          |
| **Total**                                                                                                                                                   | **$15 to $21 (dev $5 to $11)** |

Grafana reads logs straight from CloudWatch Logs, so logs are stored once. The Helm chart's Loki is not needed on AWS.

## Decisions that set these numbers

- **Valkey instead of Redis OSS:** node pricing is 20% lower for the same instance class, and Valkey is protocol compatible with BullMQ and ioredis. ElastiCache Serverless is not used: its minimum is about $6 per month for Valkey but BullMQ needs `maxmemory-policy noeviction`, which Serverless does not let you set.
- **Aurora Serverless v2 instead of provisioned:** at 0.5 to 1 ACU average ($44 to $88 per instance), Serverless v2 costs about the same as a small provisioned instance and scales up under load without an instance change. `aurora.mode: provisioned` switches when steady high load makes a fixed instance cheaper. Setting dev to `minCapacity: 0` only saves money when every service is scaled to zero: the worker runs cron jobs every minute, which keeps the database awake.
- **fck-nat in dev and qa:** $7 per month against $36.50 for a NAT gateway plus $0.045 per GB. The trade is a single instance with no automatic failover (EXC-005).
- **Fargate Spot in dev:** saves about $41 per month. Spot interruptions restart a task and drop its WebSockets. Qa and prod run on-demand.
- **No interface VPC endpoints:** each endpoint costs $7.30 per month per AZ. Images come from ghcr.io, which needs the NAT anyway. The free S3 gateway endpoint is always on.
- **No CDN, no Private CA, no Shield Advanced:** not required for the current traffic or compliance scope.
- **Public IPv4 charges** add $14.60 to $21.90 per month per environment (ALB, NAT, optional NLB). There is no IPv6-only alternative for the ALB in this design.

## Further savings

| Lever                                                     | Saving               | Trade-off                                        |
| --------------------------------------------------------- | -------------------- | ------------------------------------------------ |
| Scale dev to zero outside working hours                   | Up to $80 per month  | Cold start of about 1 minute, plus Aurora resume |
| Compute Savings Plan (1 year, no upfront) on prod Fargate | About 20% of Fargate | Commitment                                       |
| Reserved Valkey nodes (1 year) in prod                    | About 30% of Valkey  | Commitment                                       |
| Drop Container Insights in dev                            | $9 to $18 per month  | Fails ECS.12; needs a new exception              |
| One shared qa and dev ALB                                 | About $30 per month  | Couples the environments                         |
