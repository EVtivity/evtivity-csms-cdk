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
| `Evtivity-<Env>-Domain`  | Hosted zone reference                                                                       |
| `Evtivity-<Env>-Storage` | Logs bucket (ALB, S3 access, and VPC flow logs), app bucket, Grafana bucket                 |
| `Evtivity-<Env>-Data`    | Aurora PostgreSQL, Valkey, secrets, rotation                                                |
| `Evtivity-<Env>-Alb`     | ALB, listeners, ACM certificate naming each service host exactly (no wildcard), WAF         |
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

## Upgrading an environment deployed before these changes

One-time steps before the first deploy of this version to an environment that already exists:

1. These log groups are now created by the stacks. Delete the ones AWS created earlier (or import them into the Data stack), or the deploy fails with "already exists":
   - `/aws/rds/cluster/evtivity-<env>/postgresql`
   - `/aws/lambda/evtivity-<env>-db-master-rotation`
   - `/aws/lambda/evtivity-<env>-db-app-rotation`

2. Remove `observability.loki` from your config files and `CDK_LOCAL_CONFIG`. Grafana now reads logs from CloudWatch, and the deploy removes Loki, the log forwarder, and its subscription filters. With `storage.removal: retain` (prod), the `evtivity-<env>-loki-<account>` bucket stays behind. Empty and delete it when you no longer need the old Loki data.
3. Remove `vpc.flowLogRetentionDays` from your config files and `CDK_LOCAL_CONFIG`. Flow logs now go to the logs bucket and follow `storage.logsExpirationDays`.
4. NAT ids (0.1.43): the App stack now reads the NAT ids from the SSM parameter `/evtivity/<env>/network/nat-ids` instead of a Network stack export. Deploy 0.1.43 with your current `vpc.nat` first (`--all`, which updates Network before App). Switch NAT mode or count only after that deploy. The Network stack keeps the old NAT exports for this one release.
5. Services with `autoscaling` must set `desiredCount` equal to `autoscaling.min`.
6. The deploy updates the Valkey user, which resets its passwords to the current secret. Redeploy the services right after (`aws ecs update-service --force-new-deployment`, or wait for the scheduled redeploy) so no task holds an older password.
7. Per-service Valkey users (0.1.38): the deploy creates `evtivity/<env>/cache-<service>` and one Valkey user per enabled service, adds them to the user group, and moves each service to its own user. The legacy `cache-app` user and secret stay in this release so tasks that still run the old task definition keep their connection during the deploy. The next release deletes them. Nothing to do by hand.
8. Legacy cleanup (0.1.39): deploy 0.1.38 first. From an earlier release, the update fails and rolls back, because the older App or Alb stack still imports an export this release deletes. The deploy deletes the legacy shared Valkey user, its `evtivity/<env>/cache-app` secret and rotation schedule, and the superseded wildcard ACM certificate of the Domain stack, together with their stack exports. With `secrets.removal: retain` (prod) the `cache-app` secret stays in Secrets Manager: delete it by hand (`aws secretsmanager delete-secret --secret-id evtivity/<env>/cache-app`). CloudFormation leaves the wildcard certificate's DNS validation CNAME record in the hosted zone. It is harmless, and you can delete it when no other ACM certificate in the account names the zone apex.

## Configuration

`config/<env>.yaml` holds every setting, validated by `lib/config/schema.ts`. `config/<env>.local.yaml` (gitignored) is deep-merged on top for account ids, hosted zone ids, and personal overrides. An empty or comment-only local file is fine.

Validation is strict. A misspelled key (for example `waf.enable`) fails the synth instead of being ignored. The synth also fails for credentials in `appSettings` (keys ending in `Enc` belong in the dashboard), the moved `stripe.preAuthAmountCents` and `stripe.platformFeePercent` keys (now `payments.*`), the removed AI keys (see [AI assistant settings](#ai-assistant-settings-in-appsettings)), an `alb.idleTimeoutSeconds` under 60, invalid `mobile.app.*` lists, availability zones outside `region`, demo data in prod, OCPP TLS without its secret, and redeploys less often than credentials rotate.

Common changes:

| Change                                              | Config                                                                                                      |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Release a new version                               | `image.tag` (the CSMS release workflow updates it)                                                          |
| Pin one service to another image                    | `services.<name>.imageTag`                                                                                  |
| Turn a service off                                  | `services.<name>.enabled: false` (dependencies are validated)                                               |
| Size a service                                      | `services.<name>.cpu`, `memoryMiB`, `desiredCount`, `autoscaling`                                           |
| Cheaper, interruptible compute                      | `services.<name>.capacity: FARGATE_SPOT`                                                                    |
| Aurora capacity                                     | `aurora.minCapacity`, `maxCapacity`, `readers`, `mode`                                                      |
| Production sizing in a lower environment            | `sizing: prod` (see [Sizing preset](#sizing-preset-sizing-prod))                                            |
| Valkey size and HA                                  | `valkey.nodeType`, `valkey.replicas`, `valkey.multiAz` (see [Valkey replicas](#valkey-replicas))            |
| NAT                                                 | `vpc.nat.mode` (`fck-nat` or `gateway`), `vpc.nat.count` (see [Changing NAT](#changing-nat))                |
| VPC interface endpoints                             | `vpc.interfaceEndpoints` (HTTPS from the VPC CIDR only)                                                     |
| WAF (rules in [security.md](security.md#waf-rules)) | `waf.enabled`, `waf.rateLimitPer5Min`, `waf.countRules`                                                     |
| Countries allowed through WAF                       | `waf.allowCountries` (default `[US]`, `[]` turns it off)                                                    |
| WAF rate limits (per IP, 5 min)                     | `waf.ocppRateLimitPer5Min`, `authRateLimitPer5Min`, `guestRateLimitPer5Min`, `adyenWebhookRateLimitPer5Min` |
| Stripe webhook addresses                            | `waf.stripeWebhookIps` (seed only, see `scripts/stripe-webhook-ips.sh`)                                     |
| Rotation                                            | `rotation.*Days`, `ecs.redeployEveryDays` (must be shorter)                                                 |
| Settings table values                               | `appSettings` (non-secret keys only)                                                                        |

Aurora readers are pinned to the availability zones after the first (`vpc.availabilityZones`), so an AZ outage leaves a reader running. The writer is never pinned, because setting its AZ would replace it. Pinning a reader that already exists in another AZ replaces that reader once, with no writer failover.

### Sizing preset: `sizing: prod`

`sizing: prod` in `config/<env>.local.yaml` (or `--context sizing=prod` on the command line, which wins) gives dev or qa the sizing and topology of the committed `config/prod.yaml`. Use it for load tests and benchmarks, so the numbers describe a production configuration. Deploy it fresh: converting a running environment changes NAT and Valkey in place, which needs the steps below.

The preset copies (`lib/config/sizing.ts`):

- api, ocpp, ocpi, csms, portal, and worker: `cpu`, `memoryMiB`, `desiredCount`, `autoscaling`, `capacity` (on-demand or Spot), `deregistrationDelaySeconds`, `stopTimeoutSeconds`
- Aurora: `mode`, `minCapacity`, `maxCapacity`, `autoPauseSeconds`, `instanceClass`, `readers`, `performanceInsights`, `monitoringIntervalSeconds`, `poolMax`
- Valkey: `nodeType`, `replicas`, `multiAz`
- NAT `mode`, `count`, `instanceType`, and `vpc.interfaceEndpoints`
- WAF: `enabled` and the rate limits
- `ecs.containerInsights`, `ocppConnectionAuth`, the Grafana and Prometheus task sizes
- `octt.ocspResponder`, because it needs a single worker task and prod's worker autoscales

The environment keeps its identity and safety settings: account, region, domain and subdomain, resource and stack names, tags, the VPC CIDR and AZs, removal policies, deletion protection, backup and log retention, `monitoring.alarms`, `ecs.executeCommand`, the css and ocpi simulator services, `seedDemo`, `payments.allowSimulatedProvider`, and `appSettings`. Values in `config/<env>.local.yaml` still win over the preset, for example a higher `waf.rateLimitPer5Min` when a load driver sends many stations from one address. The preset has no effect in prod.

```bash
npm run synth -- --context env=dev --context sizing=prod
npm run deploy -- --context env=dev --context sizing=prod --all --profile <name>
```

Stop a lower environment without deleting it: set `desiredCount: 0` on every service (with autoscaling, also `autoscaling.min: 0`) and deploy. With `aurora.minCapacity: 0`, Aurora pauses after `aurora.autoPauseSeconds` without connections, leaving the ALB, NAT, Valkey, and secrets as the idle cost.

## Credential rotation

Three credentials rotate. The static application keys (JWT, settings encryption, initial admin, Grafana admin) do not (EXC-003).

| Secret                           | Rotated by                                                                              | Scheme                                                                                           |
| -------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `evtivity/<env>/db-master`       | Secrets Manager hosted function (PostgreSQL single user)                                | Changes the `evtivity_admin` password in place                                                   |
| `evtivity/<env>/db-app`          | Secrets Manager hosted function (PostgreSQL multi user)                                 | Alternates between `evtivity_app` and `evtivity_app_clone`, both members of `evtivity_app_group` |
| `evtivity/<env>/cache-<service>` | `lambda/valkey-rotation.ts` (one function, the user comes from the secret's `user_arn`) | Keeps the current and new password on the Valkey user at the same time                           |

Settings:

```yaml
rotation:
  enabled: true # false removes the schedules; secrets keep their current values
  databaseDays: 30 # db-master and db-app
  cacheDays: 30 # cache-<service>
ecs:
  redeployEveryDays: 7 # must be shorter than the shortest rotation interval
```

### When rotation runs

| Trigger                                                         | db-master        | db-app                      | cache-*                     |
| --------------------------------------------------------------- | ---------------- | --------------------------- | --------------------------- |
| Schedule: every `*Days` since the last rotation                 | Yes              | Yes                         | Yes                         |
| First deploy with rotation enabled                              | Yes, immediately | No                          | No                          |
| A deploy that changes `rotation.*Days` or the rotation function | Yes, immediately | No, next scheduled rotation | No, next scheduled rotation |
| Any other config change or deploy (image tag, sizing, services) | No               | No                          | No                          |
| `aws secretsmanager rotate-secret --secret-id <name>`           | Yes              | Yes                         | Yes                         |

db-app and the cache secrets never rotate as part of a deploy. db-app needs the application role that the database job creates first, and both need running tasks to be replaced before the previous credential is dropped. Only the database job uses db-master, and it reads the secret when it starts, so rotating it during a deploy is safe.

### How running tasks pick up new credentials

ECS reads secrets only when a task starts. After a db-app or cache secret rotation, the previous credential stays valid until the next rotation of that secret: the previous database role keeps its password, and the Valkey user keeps both passwords. EventBridge Scheduler forces a new deployment of every service each week (`ecs.redeployEveryDays`), well inside the 30-day interval. The config schema rejects a redeploy interval that is not shorter than the shortest rotation interval.

### Failures

A `RotationFailed`, `RotationAbandoned`, or `TestRotationFailed` event for any `evtivity/<env>/` secret publishes to the `evtivity-<env>-alerts` SNS topic. A failed rotation leaves the current credential working and retries on the next attempt. Rotation logs are in `/aws/lambda/evtivity-<env>-db-master-rotation`, `/aws/lambda/evtivity-<env>-db-app-rotation`, and `/evtivity/<env>/cache-rotation`.

### Rotate now

```bash
aws secretsmanager rotate-secret --secret-id evtivity/dev/db-app
aws secretsmanager rotate-secret --secret-id evtivity/dev/cache-api
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

The certificate in `cert` must name `ocpp-tls.<zone>` exactly. Stations reject a wildcard certificate unless `AllowCSMSTLSWildcards` (2.1) or `AllowCentralSystemTLSWildcards` (1.6) is true, and both default to false.

Stations connect to `wss://ocpp-tls.<zone>:8443/<stationId>`. Security profiles 0 to 2 keep using `wss://ocpp.<zone>/<stationId>` through the ALB. See EXC-006.

### Simulator client certificate: `cssTls.enabled`

Same secret shape, for the charging station simulator to test security profile 3.

### ALB idle timeout: `alb.idleTimeoutSeconds`

Default 120 seconds. The synth refuses a value under 60: the AI assistant streams its answers over server-sent events with a heartbeat every 15 seconds, and a shorter timeout would cut a stream while the model works.

### Plain `ws://` for OCPP: `alb.ocppPlainWs`

Forwards `http://ocpp.<zone>` to OCPP for stations limited to security profiles 0 and 1. See EXC-007 before enabling.

### Demo data: `seedDemo.enabled`

Loads the CSMS demo dataset: sites, 2000 stations, operators, drivers, sessions, and simulator stations. Off by default. Prod rejects it.

Demo drivers pay with simulated cards, so it also needs `payments.allowSimulatedProvider: true`.

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

### Simulated payments: `payments.allowSimulatedProvider`

Sets `PAYMENTS_ALLOW_SIMULATED` on the api, ocpp, and worker services, which allows the simulated (test) payment provider. It moves no money. Off by default. Prod rejects it. `appSettings['payments.provider']` accepts `none` and `stripe`, plus `simulated` when this is on. Select Adyen in Settings > Payment after the upgrade.

### Notification test sink: refused

`NOTIFICATIONS_ALLOW_TEST_SINK` and `NOTIFICATIONS_TEST_SINK_URL` send driver SMS and push to a local development service instead of Twilio and Expo. They are for the local Docker Compose stack only. The synth fails when any service's `env` or `secrets` sets either one, in every environment. The services also refuse them under `NODE_ENV=production`, which the stack sets.

### Conformance OCSP responder: `octt.ocspResponder`

Conformance (OCTT) runs started from the dashboard run in the worker. With this on, the worker starts the Test System OCSP responder on port 7110 during a run, `OCTT_OCSP_RESPONDER_URL` points the test certificates at `http://worker.<env>.evtivity.internal:7110/ocsp`, and the ocpp service may reach that port. The run adds the worker host to `pnc.ocsp.allowedPrivateHosts` while it runs. Off by default (TC_C_50, TC_C_51, TC_C_52, and TC_M_24 are then skipped). It needs exactly one worker task, so the synth fails with `services.worker.desiredCount` above 1 or autoscaling. dev turns it on.

### OCPP connection authentication limits: `ocppConnectionAuth`

After an OCPP restart every station reconnects at once. The ocpp service authenticates at most `maxConcurrent` of them at a time (default half of `aurora.poolMax`), queues up to `maxQueued` (default 1000) for at most `maxWaitMs` (default 10000), and answers the rest with 503 and `Retry-After`, so stations retry later. Sets `OCPP_AUTH_MAX_CONCURRENT`, `OCPP_AUTH_MAX_QUEUED` and `OCPP_AUTH_MAX_WAIT_MS` only when set. `maxConcurrent` may not exceed `aurora.poolMax`: raise the pool instead.

### Payment settings in `appSettings`

These keys are optional. Leave one out to keep the value set in Settings > Payment.

| Key                           | Values                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `payments.preAuthAmountCents` | Default pre-authorization amount, whole cents from 1 to 1000000                   |
| `payments.platformFeePercent` | Default platform fee, 0 to 100                                                    |
| `simulated.resultMode`        | Test provider result mode: `sync` or `async` (results confirmed later by webhook) |
| `simulated.asyncDelaySeconds` | Test provider delay of async results, whole seconds from 0 to 3600                |
| `simulated.randomFailureRate` | Test provider failure rate of cards without a scenario, 0 to 1                    |

`stripe.preAuthAmountCents` and `stripe.platformFeePercent` moved to `payments.*`. The synth rejects the old names. The upgrade copies the stored values to the new settings.

### AI assistant settings in `appSettings`

These keys are optional. Leave one out to keep the value set in the dashboard. Provider API keys are not config values: enter them in the dashboard, one per provider (`ai.<provider>.apiKeyEnc`).

| Key                                        | Values                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `chatbotAi.provider`, `supportAi.provider` | `anthropic`, `openai`, `gemini`, `deepseek`, or empty                                      |
| `chatbotAi.effort`, `supportAi.effort`     | `low`, `medium`, or `high`                                                                 |
| `supportAi.tone`                           | `professional`, `friendly`, or `formal`                                                    |
| `ai.<provider>.baseUrl`                    | Empty for the official endpoint, or an `https` URL without credentials, query, or fragment |
| `ai.rateLimit.userPerMinute`               | Whole number from 1 to 1000                                                                |
| `ai.rateLimit.sitePerMinute`               | Whole number from 1 to 100000                                                              |
| `ai.budget.userDailyTokens`                | Whole number from 0 to 10000000000 (0 means no limit)                                      |
| `ai.maxToolCallsPerTurn`                   | Whole number from 1 to 100                                                                 |
| `ai.conversationRetentionDays`             | Whole number of days from 1 to 3650                                                        |
| `ai.attachments.maxBytes`                  | Whole number of bytes from 1 to 33554432 (32 MiB)                                          |
| `ai.attachments.maxPerMessage`             | Whole number from 1 to 20                                                                  |
| `opsAi.enabled`                            | Operations AI for automatic insights and AI workers: `true` or `false`                     |
| `opsAi.provider`                           | `anthropic`, `openai`, `gemini`, `deepseek`, or empty                                      |
| `opsAi.model`, `opsAi.systemPrompt`        | Text. Empty uses the provider's router model and the built-in prompt                       |
| `opsAi.effort`                             | `low`, `medium`, or `high`                                                                 |
| `aiInsights.<subject>.enabled`             | `true` or `false` for `station`, `session`, and `authorization`                            |
| `aiInsights.debounceSeconds`               | Whole number of seconds from 0 to 3600                                                     |
| `aiInsights.cooldownMinutes`               | Whole number of minutes from 1 to 10080                                                    |
| `aiInsights.siteIncidentThreshold`         | Whole number of stations from 2 to 1000                                                    |
| `aiInsights.maxPerSitePerDay`              | Whole number from 1 to 10000                                                               |
| `aiInsights.primaryLanguage`               | `en`, `de`, `es`, `ko`, `zh`, or `zh-TW`                                                   |
| `aiInsights.retentionDays`                 | Whole number of days from 1 to 3650                                                        |
| `aiWorkers.<job>.enabled`                  | `true` or `false` for `networkSummary`, `stuckSessions`, and `tariffAnomalies`             |
| `aiWorkers.stuckSessions.idleMinutes`      | Whole number of minutes from 15 to 1440                                                    |
| `aiWorkers.stuckSessions.useModel`         | `true` or `false`                                                                          |
| `aiWorkers.proposalTtlHours`               | Whole number of hours from 1 to 168                                                        |
| `ai.mcp.enabled`                           | `true` or `false`                                                                          |
| `ai.mcp.rateLimitPerMinute`                | Whole number from 1 to 10000                                                               |
| `ai.mcp.dailyCallsPerKey`                  | Whole number from 1 to 10000000                                                            |
| `ai.mcp.proposalTtlMinutes`                | Whole number of minutes from 5 to 1440                                                     |
| `ai.mcp.allowedOrigins`                    | List of at most 50 origins, `scheme://host[:port]` with `http` or `https` and no path      |
| `ai.budget.companyMonthlyTokens`           | Whole number from 0 to 1000000000000 (0 means no limit)                                    |
| `ai.budget.siteMonthlyTokens`              | Whole number from 0 to 1000000000000 (0 means no limit)                                    |
| `ai.budget.siteDailyTokens`                | Whole number from 0 to 10000000000 (0 means no limit)                                      |
| `ai.budget.warnPercent`                    | Whole number from 1 to 100                                                                 |

The synth rejects the removed keys `chatbotAi.temperature`, `chatbotAi.topP`, `chatbotAi.topK` and the same `supportAi.*` keys (set `<surface>.effort` instead), and `chatbotAi.apiKey` and `supportAi.apiKey` (one key per provider, entered in the dashboard).

AI assistant uploads land in the app bucket under `ai-uploads/quarantine/` until the API has checked them. A lifecycle rule on that prefix deletes objects, noncurrent versions, and incomplete multipart uploads after one day. The app bucket CORS allows `POST` for the presigned POST uploads.

### Mobile app builds in `appSettings`

The API accepts a 3D Secure return URL from the driver app only when it leads back to one of your app builds. These two keys take lists, stored as JSON arrays. Lists are not allowed for any other key. Leave a key out to keep the value set in the dashboard (the defaults are `[evtivity]` and `[com.evtivity.driver]`). An empty list accepts no app.

| Key                              | Values                                                                                                                                                                                                |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mobile.app.urlSchemes`          | Custom URL schemes of the app brands: lowercase, starting with a letter, then letters, digits, `+`, `.` or `-`. Not `http`, `https`, `javascript`, `data`, `file`, `about`, `blob` or `adyencheckout` |
| `mobile.app.androidPackageNames` | Android application ids of the app brands: two or more dot-separated segments, each a letter followed by letters, digits or `_`                                                                       |

```yaml
appSettings:
  mobile.app.urlSchemes: [evtivity, acme]
  mobile.app.androidPackageNames: [com.evtivity.driver, com.acme.driver]
```

The synth applies the same rules as the CSMS validators and the Helm chart.

## Observability and alerts

Grafana (with the Helm chart's dashboards and alert rules), the CloudWatch dashboards and alarms, the alerts topic, and Grafana access are covered in [observability.md](observability.md).

## Valkey replicas

`valkey.replicas` adds read replicas, and with one or more replicas Multi-AZ and automatic failover turn on (`valkey.multiAz`, default on when `replicas` is above 0). A new environment gets both in one deploy.

An existing single node cannot get a replica and Multi-AZ in one update: ElastiCache refuses Multi-AZ until the nodes run in two AZs ("Cannot enable Multi-AZ unless there are nodes across two or more AZs"). Setting the node AZs (`PreferredCacheClusterAZs`) would replace the replication group, so the stack never sets them. Add a replica in two deploys of the Data stack:

1. Set `valkey.replicas: 1` and `valkey.multiAz: false`, then deploy. ElastiCache adds the replica and places it in an AZ of the subnet group. Check that the nodes run in two AZs:

   ```bash
   aws elasticache describe-cache-clusters --query "CacheClusters[?ReplicationGroupId=='evtivity-<env>'].[CacheClusterId,PreferredAvailabilityZone]" --output text
   ```

2. Remove `valkey.multiAz` (or set it to `true`), then deploy. This turns on automatic failover and Multi-AZ.

To remove the replicas, reverse the order: `valkey.multiAz: false` first, then `valkey.replicas: 0`. Adding or removing a replica does not interrupt the primary.

## Changing NAT

The Network stack writes the NAT instance or gateway ids to the SSM parameter `/evtivity/<env>/network/nat-ids`, and the App stack reads them for its NAT alarms and dashboard widgets. No stack export ties the two, so the Network stack can replace the NAT (a new `vpc.nat.mode` or `count`, or a new fck-nat AMI) in place:

1. Change `vpc.nat` and deploy the Network stack. Private subnets lose outbound traffic for about a minute while the routes move.
2. Deploy the App stack. CloudFormation reads the parameter again on every App stack update. A change of mode or count changes the App template, so the deploy updates it. After a new fck-nat AMI, the template is the same: run `npm run deploy -- --context env=<env> --exclusively Evtivity-<Env>-App --force` so the alarms follow the new instance.

Upgrading from 0.1.42 or earlier: see [Upgrading](#upgrading-an-environment-deployed-before-these-changes), step 4.

## Updating the fck-nat AMI

`vpc.nat.amiIds` pins the AMI per region. Find the latest:

```bash
aws ec2 describe-images --owners 568608671756 \
  --filters 'Name=name,Values=fck-nat-al2023-*-arm64-ebs' \
  --query 'sort_by(Images,&CreationDate)[-1].[ImageId,Name]' --output text
```

A new AMI replaces the NAT instance, which interrupts outbound traffic for about a minute. Then redeploy the App stack with `--force` (see [Changing NAT](#changing-nat)).

## Tearing down

```bash
npm run destroy -- --context env=dev --all --profile <name>
```

With the dev settings (`removal: destroy` everywhere) this deletes all data. Prod settings retain Aurora (final snapshot), buckets, log groups, and application secrets.

A few things can remain after a destroy. Delete them when the environment is gone for good:

- ACM's DNS validation CNAME (`_<hash>.<subdomain>.<apex>`) in the hosted zone.
- `/aws/ecs/containerinsights/evtivity-<env>/performance`, which ECS creates for Container Insights.

```bash
aws logs describe-log-groups --log-group-name-prefix /aws/ecs/containerinsights/evtivity-dev/ --query 'logGroups[].logGroupName'
```

## GitHub Actions

- `ci.yml` (pull requests and pushes to `main`): typecheck, lint, and the tests once (they synthesize every environment and run cdk-nag), then a full `cdk synth` per environment to bundle the Lambda functions. No AWS credentials needed.
- `release.yml` (push to `main` that changes `package.json`, or manual): tags `v<version>` and publishes a GitHub release with a changelog from conventional commits. The CSMS release workflow bumps `package.json` and `image.tag` on every CSMS release, so each CSMS version gets a matching CDK release, the same as the Helm chart.
- `deploy.yml` (manual, choose an environment and a stack or `all`): writes `config/<env>.local.yaml` from the `CDK_LOCAL_CONFIG` variable of the chosen GitHub environment (the whole YAML file, the same one you keep locally, validated as strictly as the committed config, so a removed or misspelled key fails the deploy), runs the checks, assumes `AWS_DEPLOY_ROLE_ARN` through OIDC in `AWS_REGION` (default `us-east-1`), then synthesizes once, diffs every stack, and deploys that same output. Only one deploy per environment runs at a time. Give the `prod` environment required reviewers.
