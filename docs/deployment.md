# Deployment

## Prerequisites

- AWS credentials for the target account (for example `aws sso login --profile <name>`)
- Node.js 22 or later
- A Route 53 public hosted zone for the apex domain in the same account. The stacks add only subdomain records (`csms.dev.evtivity.com`, ...) and the ACM validation record. They never touch the apex or `www`.
- A published CSMS release on `ghcr.io/evtivity/evtivity-csms/*`. The images must include the credential-assembling entrypoint and the non-root nginx layout (0.1.22 or later).

## Stacks

| Stack                    | Contents                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `Evtivity-<Env>-Network` | VPC, NAT (fck-nat or gateway), flow logs, S3 gateway endpoint, ALB/task/NLB security groups |
| `Evtivity-<Env>-Domain`  | ACM certificate for `<zone>` and `*.<zone>`                                                 |
| `Evtivity-<Env>-Storage` | Logs bucket and app bucket                                                                  |
| `Evtivity-<Env>-Data`    | Aurora PostgreSQL, Valkey, secrets, rotation                                                |
| `Evtivity-<Env>-Alb`     | ALB, listeners, WAF                                                                         |
| `Evtivity-<Env>-App`     | ECS cluster, database job, services, DNS records, OCPP TLS NLB, redeploy schedules, alarms  |

## First deploy

```bash
npm ci
cp config/dev.local.yaml.example config/dev.local.yaml   # account, hosted zone id, admin email

npx cdk bootstrap aws://<account>/us-east-1 --profile <name>   # once per account and region
npm run synth -- --context env=dev
npm run deploy -- --context env=dev --all --profile <name>
```

What happens in the App stack on every deploy that changes the database job (new image tag, settings, or environment):

1. A one-shot Fargate task runs in the migrate image, as the cluster owner:
   1. `npm run migrate`
   2. creates the `evtivity_app_group` role and the application login if missing, and grants privileges, including default privileges for future tables
   3. `npm run seed:admin` (idempotent)
   4. upserts `appSettings` plus `s3.bucket` and `s3.region` into the settings table
2. CloudFormation waits for the task to exit. A non-zero exit fails the deployment and rolls back, so services never start against a database that failed to migrate. The error names the log stream.
3. Services start or update only after the job succeeds.

First sign-in: the admin email is `initialAdmin.email`. The password is in the `evtivity/<env>/initial-admin` secret. The dashboard forces a password change at first sign-in.

```bash
aws secretsmanager get-secret-value --secret-id evtivity/dev/initial-admin --query SecretString --output text
```

## Configuration

`config/<env>.yaml` holds every setting, validated by `lib/config/schema.ts`. `config/<env>.local.yaml` (gitignored) is deep-merged on top for account ids, hosted zone ids, and personal overrides.

Common changes:

| Change                           | Config                                                            |
| -------------------------------- | ----------------------------------------------------------------- |
| Release a new version            | `image.tag` (the CSMS release workflow updates it)                |
| Pin one service to another image | `services.<name>.imageTag`                                        |
| Turn a service off               | `services.<name>.enabled: false` (dependencies are validated)     |
| Size a service                   | `services.<name>.cpu`, `memoryMiB`, `desiredCount`, `autoscaling` |
| Cheaper, interruptible compute   | `services.<name>.capacity: FARGATE_SPOT`                          |
| Aurora capacity                  | `aurora.minCapacity`, `maxCapacity`, `readers`, `mode`            |
| Valkey size and HA               | `valkey.nodeType`, `valkey.replicas`                              |
| NAT                              | `vpc.nat.mode` (`fck-nat` or `gateway`), `vpc.nat.count`          |
| WAF                              | `waf.enabled`, `waf.rateLimitPer5Min`, `waf.countRules`           |
| Rotation                         | `rotation.*Days`, `ecs.redeployEveryDays` (must be shorter)       |
| Settings table values            | `appSettings` (non-secret keys only)                              |

Stop a lower environment without deleting it: set `desiredCount: 0` on every service and deploy. With `aurora.minCapacity: 0`, Aurora pauses after `aurora.autoPauseSeconds` without connections, leaving the ALB, NAT, Valkey, and secrets as the idle cost.

## Credential rotation

Three credentials rotate. The static application keys (JWT, settings encryption, initial admin, Grafana admin) do not (EXC-003).

| Secret                     | Rotated by                                               | Scheme                                                                                           |
| -------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `evtivity/<env>/db-master` | Secrets Manager hosted function (PostgreSQL single user) | Changes the `evtivity_admin` password in place                                                   |
| `evtivity/<env>/db-app`    | Secrets Manager hosted function (PostgreSQL multi user)  | Alternates between `evtivity_app` and `evtivity_app_clone`, both members of `evtivity_app_group` |
| `evtivity/<env>/cache-app` | `lambda/valkey-rotation.ts`                              | Keeps the current and new password on the Valkey user at the same time                           |

Settings:

```yaml
rotation:
  enabled: true # false removes the schedules; secrets keep their current values
  databaseDays: 30 # db-master and db-app
  cacheDays: 30 # cache-app
ecs:
  redeployEveryDays: 7 # must be shorter than the shortest rotation interval
```

### When rotation runs

| Trigger                                                         | db-master        | db-app                      | cache-app                   |
| --------------------------------------------------------------- | ---------------- | --------------------------- | --------------------------- |
| Schedule: every `*Days` since the last rotation                 | Yes              | Yes                         | Yes                         |
| First deploy with rotation enabled                              | Yes, immediately | No                          | No                          |
| A deploy that changes `rotation.*Days` or the rotation function | Yes, immediately | No, next scheduled rotation | No, next scheduled rotation |
| Any other config change or deploy (image tag, sizing, services) | No               | No                          | No                          |
| `aws secretsmanager rotate-secret --secret-id <name>`           | Yes              | Yes                         | Yes                         |

db-app and cache-app never rotate as part of a deploy. db-app needs the application role that the database job creates first, and both need running tasks to be replaced before the previous credential is dropped. Only the database job uses db-master, and it reads the secret when it starts, so rotating it during a deploy is safe.

### How running tasks pick up new credentials

ECS reads secrets only when a task starts. After a db-app or cache-app rotation, the previous credential stays valid until the next rotation of that secret: the previous database role keeps its password, and the Valkey user keeps both passwords. EventBridge Scheduler forces a new deployment of every service each week (`ecs.redeployEveryDays`), well inside the 30-day interval. The config schema rejects a redeploy interval that is not shorter than the shortest rotation interval.

### Failures

A `RotationFailed`, `RotationAbandoned`, or `TestRotationFailed` event for any `evtivity/<env>/` secret publishes to the `evtivity-<env>-alerts` SNS topic. A failed rotation leaves the current credential working and retries on the next attempt. Rotation logs are in `/aws/lambda/evtivity-<env>-db-master-rotation`, `/aws/lambda/evtivity-<env>-db-app-rotation`, and `/evtivity/<env>/cache-rotation`.

### Rotate now

```bash
aws secretsmanager rotate-secret --secret-id evtivity/dev/db-app
aws secretsmanager rotate-secret --secret-id evtivity/dev/cache-app
# Optional: pick up the new credentials now instead of at the weekly redeploy
aws ecs update-service --cluster evtivity-dev --service evtivity-dev-api --force-new-deployment
```

## Optional features

### OCPP TLS (security profile 3): `ocppTls.enabled`

Adds an internet-facing NLB on `ocppTls.port` (8443) with TCP passthrough, so the OCPP server terminates TLS and verifies client certificates. Create the secret first:

```bash
aws secretsmanager create-secret --name evtivity/dev/ocpp-tls --secret-string "$(jq -n \
  --arg cert "$(cat tls.crt)" --arg key "$(cat tls.key)" --arg ca "$(cat ca.crt)" \
  '{cert:$cert, key:$key, ca:$ca}')"
```

Stations connect to `wss://ocpp-tls.<zone>:8443/<stationId>`. Security profiles 0 to 2 keep using `wss://ocpp.<zone>/<stationId>` through the ALB. See EXC-006.

### Simulator client certificate: `cssTls.enabled`

Same secret shape, for the charging station simulator to test security profile 3.

### Plain `ws://` for OCPP: `alb.ocppPlainWs`

Forwards `http://ocpp.<zone>` to OCPP for stations limited to security profiles 0 and 1. See EXC-007 before enabling.

### Demo data: `seedDemo.enabled`

Loads the CSMS demo dataset: sites, 2000 stations, operators, drivers, sessions, and simulator stations. Off by default. Prod rejects it.

- It runs once, after the database job. Later deploys, including image updates, do not rerun it. Bump `seedDemo.revision` to run it again. The seed skips the dataset when it is already present, so a rerun mainly reapplies the steps below.
- The seed rewrites every default setting. The job then reapplies `appSettings` and the stack settings, so the result matches a normal deploy.
- The seed resets the initial admin password to the value in `evtivity/<env>/initial-admin` and forces a reset at next sign-in.
- Demo operators (`operator1@evtivity.local` to `operator9@evtivity.local`) and the demo driver (`driver@evtivity.local`) get the password in `evtivity/<env>/demo-password`, not the seed's built-in passwords. Operators must change it at first sign-in. The driver portal has no forced reset.
- The css service starts only `seedDemo.stationLimit` demo stations (default 50). Security profile 3 stations stay disabled. Security profile 2 stations stay disabled unless `ocppTls.enabled`.

```bash
aws secretsmanager get-secret-value --secret-id evtivity/dev/demo-password \
  --query SecretString --output text
```

Logs are in `/evtivity/<env>/db-job` under the `seed-demo/` stream prefix.

## Observability: `observability.enabled`

Runs the same monitoring stack as the Helm chart, with the same dashboards (system metrics, business metrics, logs, alerts) and the same 12 Grafana alert rules:

| Component  | How it runs on AWS                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Prometheus | Agent mode on Fargate. Scrapes the API's `/metrics` (port 9091) through Cloud Map and remote-writes to Amazon Managed Service for Prometheus.                                                                      |
| Loki       | Single binary on Fargate. Chunks and indexes in the `loki` bucket, WAL on EFS, retention `observability.loki.retentionDays`.                                                                                       |
| Log intake | A Lambda subscribed to each service's CloudWatch log group pushes events to Loki with the `service` label the logs dashboard filters on.                                                                           |
| Grafana    | Fargate with its database on EFS. Provisioned at start from the `grafana` bucket: dashboards and alert rules from the CSMS repo, generated datasources (AMP through the task role, Loki) and an SNS contact point. |
| Alerts     | Grafana publishes to the environment's `evtivity-<env>-alerts` SNS topic, shared with the CloudWatch alarms. Set `monitoring.alarmEmail` to subscribe an address (the recipient must confirm).                     |

Access: `grafana.<zone>` always routes to Grafana, and the ALB's web ACL blocks every source address outside the WAF IP set `evtivity-<env>-grafana-allow`. Edit that set at any time, no deploy needed, and changes apply within seconds:

```bash
export AWS_PROFILE=<name>
./scripts/grafana-access.sh dev list
./scripts/grafana-access.sh dev add me              # this machine's public IP
./scripts/grafana-access.sh dev add 203.0.113.0/24  # an office or VPN range
./scripts/grafana-access.sh dev remove 203.0.113.0/24
```

`observability.grafana.allowedCidrs` seeds the set when it is first created. Changing that list later replaces the set's contents on the next deploy, including addresses added with the script, so keep the list empty or in sync. Environments without `waf.enabled` get a web ACL with only this rule (about $6 per month).

Sign in as `admin` with the password from `evtivity/<env>/grafana-admin`.

Dashboard and alert changes: edit them in the CSMS repo's `prometheus/grafana/`, then run `./scripts/sync-observability.sh <csms repo>/prometheus/grafana` here and deploy. The deploy uploads the files and restarts Grafana when their content changed.

## Updating the fck-nat AMI

`vpc.nat.amiIds` pins the AMI per region. Find the latest:

```bash
aws ec2 describe-images --owners 568608671756 \
  --filters 'Name=name,Values=fck-nat-al2023-*-arm64-ebs' \
  --query 'sort_by(Images,&CreationDate)[-1].[ImageId,Name]' --output text
```

A new AMI replaces the NAT instance, which interrupts outbound traffic for about a minute.

## Tearing down

```bash
npm run destroy -- --context env=dev --all --profile <name>
```

With the dev settings (`removal: destroy` everywhere) this deletes all data. Prod settings retain Aurora (final snapshot), buckets, log groups, and application secrets. ACM leaves its DNS validation CNAME in the hosted zone. Delete it when the environment is gone for good.

## GitHub Actions

- `ci.yml` (pull requests): typecheck, lint, compliance tests, and `cdk synth` for every environment. No AWS credentials needed.
- `release.yml` (push to `main` that changes `package.json`, or manual): tags `v<version>` and publishes a GitHub release with a changelog from conventional commits. The CSMS release workflow bumps `package.json` and `image.tag` on every CSMS release, so each CSMS version gets a matching CDK release, the same as the Helm chart.
- `deploy.yml` (manual): writes `config/<env>.local.yaml` from the repository variables `AWS_ACCOUNT_ID`, `HOSTED_ZONE_ID`, and `INITIAL_ADMIN_EMAIL` of the chosen GitHub environment, assumes `AWS_DEPLOY_ROLE_ARN` through OIDC, then diffs and deploys. Give the `prod` environment required reviewers.
