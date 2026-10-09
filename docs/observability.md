# Observability

How to see what an EVtivity environment is doing: metrics, logs, dashboards, and alerts. There are two views of the same environment:

- **Grafana** (`observability.enabled`): the same dashboards and alert rules as the Helm chart. Application and business metrics (sessions, stations, revenue, OCPP health), plus logs.
- **CloudWatch** (`monitoring.dashboard`, `monitoring.alarms`): AWS-native data only. Load balancer, ECS services, Aurora, Valkey, NAT, logs, and alarm status.

## Architecture

```mermaid
flowchart LR
  API[API service<br/>/metrics on 9091] -->|scrape every 60s| Agent[Prometheus agent<br/>Fargate]
  Agent -->|remote_write, SigV4| AMP[(Amazon Managed<br/>Service for Prometheus)]
  Services[All services] -->|awslogs| CWL[(CloudWatch Logs)]
  Grafana[Grafana<br/>Fargate] -->|PromQL| AMP
  Grafana -->|Logs Insights| CWL
  Grafana --> EFS[(EFS: Grafana database)]
  Grafana -->|alerts| SNS[SNS alerts topic]
  CW[CloudWatch alarms<br/>and EventBridge rules] --> SNS
  SNS --> Email[alarmEmail]
```

| Component                             | What it does                                                                                                                                                                                | Where its data lives                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Prometheus agent                      | Scrapes the API's `/metrics` endpoint every `observability.prometheus.scrapeIntervalSeconds` and forwards the samples. Stores no history and answers no queries.                            | Only a small retry buffer on the task's disk    |
| Amazon Managed Service for Prometheus | Stores the metrics and answers Grafana's PromQL queries. One workspace per environment, `evtivity-<env>`.                                                                                   | The managed service, 150 days (service default) |
| Grafana                               | Dashboards and alert rules. Provisioned at every start from the `grafana` bucket: dashboards, alert rules, data sources (Prometheus and CloudWatch), the logs dashboard, SNS contact point. | Its own settings and users on EFS               |
| CloudWatch Logs                       | Every service's logs. Grafana queries it directly with Logs Insights through its CloudWatch data source.                                                                                    | CloudWatch, `logs.retentionDays`                |

Why there is no Loki: the Helm chart ships logs to Loki because Kubernetes has no central log store. On AWS every service already writes to CloudWatch Logs, so Grafana reads it directly and a second copy would only add cost and moving parts. The logs dashboard is the one Grafana dashboard that differs from the Helm chart: the CDK generates it with Logs Insights queries instead of LogQL, with the same UID, title, and layout.

Why the metrics store is a managed service: Prometheus needs a durable disk. Fargate tasks lose their local disk on every restart (deploys, the weekly credential redeploy, Spot interruptions), and Prometheus does not support NFS storage such as EFS. The Helm chart runs a Prometheus server on a persistent volume instead. The queries, dashboards, and alert rules are identical in both.

## Finding application errors

Every service writes to CloudWatch Logs first. Grafana's logs dashboard and the CloudWatch logs dashboard both read these groups.

| Log group                                               | What                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| `/evtivity/<env>/api`                                   | REST API behind the dashboard and the driver portal          |
| `/evtivity/<env>/ocpp`                                  | OCPP server: station connections, transactions, event emails |
| `/evtivity/<env>/worker`                                | Background jobs: reservations, reports, notifications        |
| `/evtivity/<env>/ocpi`                                  | OCPI roaming                                                 |
| `/evtivity/<env>/css`                                   | Charging station simulator                                   |
| `/evtivity/<env>/csms`, `/evtivity/<env>/portal`        | nginx for the dashboard and portal                           |
| `/evtivity/<env>/db-job`                                | Migrations, role grants, settings, and the demo seed         |
| `/aws/rds/cluster/evtivity-<env>/postgresql`            | Aurora PostgreSQL                                            |
| `/evtivity/<env>/valkey-slow-log`                       | Valkey slow commands                                         |
| `/evtivity/<env>/grafana`, `/evtivity/<env>/prometheus` | The observability stack itself                               |

Where to look:

1. **Grafana**, EVtivity folder, **Logs**: the "All Errors" panel covers every service, then errors and full logs per service.
2. **CloudWatch dashboard `evtivity-<env>-logs`**: the same per-service error tables through Logs Insights, in the AWS console.
3. **The CLI**, for exact searches and scripting:

```bash
# Follow one service
aws logs tail /evtivity/dev/api --follow

# Errors in the last hour. The Node services log JSON: level 50 is error, 60 is fatal.
aws logs filter-log-events --log-group-name /evtivity/dev/ocpp \
  --start-time $(( ($(date +%s) - 3600) * 1000 )) \
  --filter-pattern '?"\"level\":50" ?"\"level\":60" ?ERROR' \
  --query 'events[].message' --output text
```

## Accessing Grafana

`grafana.<zone>` routes to Grafana, and the load balancer's web ACL blocks every source address outside the WAF IP set `evtivity-<env>-grafana-allow`. Edit the set at any time. Changes apply within seconds and need no deploy:

```bash
export AWS_PROFILE=<name>
./scripts/grafana-access.sh dev list
./scripts/grafana-access.sh dev add me              # this machine's public IP
./scripts/grafana-access.sh dev add 203.0.113.0/24  # an office or VPN range
./scripts/grafana-access.sh dev remove 203.0.113.0/24
```

`observability.grafana.allowedCidrs` seeds the set when it is created. Changing that list later replaces the set's contents on the next deploy, including addresses added with the script, so keep it empty or in sync. The block matches any Host header that starts with the Grafana hostname, so adding a port or a trailing dot does not get around it.

Sign in as `admin` with the password in `evtivity/<env>/grafana-admin`:

```bash
aws secretsmanager get-secret-value --secret-id evtivity/dev/grafana-admin \
  --query SecretString --output text
```

## Grafana dashboards

All four are in the EVtivity folder:

| Dashboard        | Shows                                                                                                   | Source     |
| ---------------- | ------------------------------------------------------------------------------------------------------- | ---------- |
| System metrics   | API request rate, errors, latency by route, Node.js heap, event loop lag, GC, OCPP connections and ping | Prometheus |
| Business metrics | Drivers, sites, stations, connectors, sessions, energy, revenue, reservations, payments, popular hours  | Prometheus |
| Logs             | Errors and full logs per service (API, OCPP, worker, simulator, PostgreSQL, Valkey, csms, portal)       | CloudWatch |
| Alerts           | Firing alerts and the metrics behind each alert rule                                                    | Prometheus |

The dashboards and alert rules are copied from the CSMS repo, which is their source of truth (the Helm chart copies the same files). The sync skips the Helm logs dashboard, since the CDK generates its own for CloudWatch (`lib/constructs/log-queries.ts`). After a change in the CSMS repo:

```bash
./scripts/sync-observability.sh <csms repo>/prometheus/grafana
```

Commit the result and deploy. The deploy uploads the files and restarts Grafana when their content changed.

## CloudWatch dashboards

With `monitoring.dashboard: true` (the default), each environment gets three dashboards built only from AWS data:

| Dashboard               | Shows                                                                                                                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evtivity-<env>-system` | Load balancer requests, errors, p50/p95/p99 response time, open and rejected connections. CPU, memory, and running tasks per service. Aurora capacity, connections, latency. Valkey CPU, memory, connections per node. NAT traffic and health. |
| `evtivity-<env>-logs`   | Logs Insights tables: errors across every service, then errors and recent logs per service. Same log groups as the Grafana logs dashboard.                                                                                                     |
| `evtivity-<env>-alerts` | Status of every CloudWatch alarm, newest change first.                                                                                                                                                                                         |

The system and alerts dashboards link to Grafana for application and business metrics. Logs Insights bills for the data each query scans (about $0.005 per GB), in both the CloudWatch and the Grafana logs dashboards, so both default to the last hour.

## Alerts

Everything publishes to the `evtivity-<env>-alerts` SNS topic, encrypted with its own KMS key. Set `monitoring.alarmEmail` to subscribe an address. The recipient must confirm the subscription email before anything arrives.

Always on:

- Grafana alert rules (12, the same as the Helm chart), when observability is on
- Credential rotation failed or was abandoned (EventBridge, from CloudTrail)
- An ECS deployment failed, including the scheduled redeploys (EventBridge)

With `monitoring.alarms: true`:

- Load balancer 5xx, unhealthy targets per service, service CPU and memory
- A service running fewer tasks than desired for 10 minutes
- Aurora capacity (or CPU), connections near the services' pool limit, reader lag
- Valkey memory and engine CPU on every node
- NAT instance status checks, or NAT gateway port exhaustion

The NAT alarms and dashboard widgets take the NAT ids from the SSM parameter `/evtivity/<env>/network/nat-ids`, read on each App stack deploy. After the NAT changes, deploy the App stack so they follow the new ids ([deployment.md](deployment.md#changing-nat)).

The NAT instance also recovers without anyone subscribed: EC2 moves it to new hardware after a host failure (automatic recovery), and an alarm reboots it when it stops responding.

## Configuration

| Option                                                   | Default    | Notes                                                       |
| -------------------------------------------------------- | ---------- | ----------------------------------------------------------- |
| `observability.enabled`                                  | `false`    | Prometheus agent, Grafana, the metrics workspace            |
| `observability.grafana.allowedCidrs`                     | `[]`       | Seeds the Grafana allowlist                                 |
| `observability.grafana.hostname`                         | `grafana`  | `<hostname>.<subdomain>.<apex>`                             |
| `observability.prometheus.scrapeIntervalSeconds`         | `60`       | Same as the Helm chart                                      |
| `observability.<component>.cpu`, `memoryMiB`, `capacity` | see schema | `FARGATE_SPOT` is about 70% cheaper for dev                 |
| `monitoring.dashboard`                                   | `true`     | The three CloudWatch dashboards                             |
| `monitoring.alarms`                                      | `true`     | The CloudWatch alarms listed above                          |
| `monitoring.alarmEmail`                                  | none       | Subscribes an address to the alerts topic                   |
| `logs.retentionDays`                                     | `30`       | CloudWatch log groups, which Grafana's logs dashboard reads |

With the prod sizing preset (`sizing: prod`, [deployment.md](deployment.md#sizing-preset-sizing-prod)), a lower environment gets prod's Container Insights setting and Grafana and Prometheus task sizes, and keeps its own `monitoring.alarms`, `monitoring.dashboard`, and log retention. Benchmarks on dev usually leave alarms off.

## Network

Grafana and Prometheus run in their own security group. Grafana is reachable from the internet through the load balancer, so it has no network path to Aurora or Valkey. Allowed paths:

- Load balancer to Grafana on 3000
- Prometheus to the API metrics port 9091

When a change moves a service to a different security group, deploy it so the new rules exist before the old ones go away. The Network stack deploys before the App stack, so removing a rule there cuts off a service that the App stack has not moved yet.

## Cost

Observability adds about $5 to $11 per month in dev (Fargate Spot) and $15 to $21 in qa and prod: two small Fargate tasks, EFS, the metrics workspace (about $1 to $5 at one scrape target per minute), and S3, plus Logs Insights for each logs dashboard view. Environments without `waf.enabled` also pay about $6 per month for the web ACL that guards Grafana. See [`cost-report.md`](cost-report.md).

## Troubleshooting

| Symptom                                   | Check                                                                                                                                                                                                                              |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Grafana returns 403                       | Your address is not in the allowlist. `./scripts/grafana-access.sh <env> add me`                                                                                                                                                   |
| Grafana returns 503                       | The task is starting or failing its health check. First start runs database migrations on EFS and can take up to 5 minutes. `aws logs tail /evtivity/<env>/grafana`                                                                |
| Metrics dashboards show "No data"         | `aws logs tail /evtivity/<env>/prometheus` for scrape or remote-write errors. The API must be running.                                                                                                                             |
| Logs dashboard is empty or shows an error | Test the CloudWatch data source (Connections, Data sources, CloudWatch). Its health check covers both logs and metrics. Grafana's task role must allow `logs:StartQuery` on the log group. `aws logs tail /evtivity/<env>/grafana` |
| No alert emails                           | The subscription must be confirmed. `aws sns list-subscriptions-by-topic` shows `PendingConfirmation` until then.                                                                                                                  |
