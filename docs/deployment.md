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
| `Evtivity-<Env>-Domain`  | Hosted zone reference. Holds the superseded wildcard certificate until the next release     |
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
4. Services with `autoscaling` must set `desiredCount` equal to `autoscaling.min`.
5. The deploy updates the Valkey user, which resets its passwords to the current secret. Redeploy the services right after (`aws ecs update-service --force-new-deployment`, or wait for the scheduled redeploy) so no task holds an older password.
6. Per-service Valkey users (0.1.38): the deploy creates `evtivity/<env>/cache-<service>` and one Valkey user per enabled service, adds them to the user group, and moves each service to its own user. The legacy `cache-app` user and secret stay in this release so tasks that still run the old task definition keep their connection during the deploy. The next release deletes them. Nothing to do by hand.

## Configuration

`config/<env>.yaml` holds every setting, validated by `lib/config/schema.ts`. `config/<env>.local.yaml` (gitignored) is deep-merged on top for account ids, hosted zone ids, and personal overrides. An empty or comment-only local file is fine.

Validation is strict. A misspelled key (for example `waf.enable`) fails the synth instead of being ignored. The synth also fails for credentials in `appSettings` (keys ending in `Enc` belong in the dashboard), the moved `stripe.preAuthAmountCents` and `stripe.platformFeePercent` keys (now `payments.*`), invalid `mobile.app.*` lists, availability zones outside `region`, demo data in prod, OCPP TLS without its secret, and redeploys less often than credentials rotate.

Common changes:

| Change                                              | Config                                                                                                      |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Release a new version                               | `image.tag` (the CSMS release workflow updates it)                                                          |
| Pin one service to another image                    | `services.<name>.imageTag`                                                                                  |
| Turn a service off                                  | `services.<name>.enabled: false` (dependencies are validated)                                               |
| Size a service                                      | `services.<name>.cpu`, `memoryMiB`, `desiredCount`, `autoscaling`                                           |
| Cheaper, interruptible compute                      | `services.<name>.capacity: FARGATE_SPOT`                                                                    |
| Aurora capacity                                     | `aurora.minCapacity`, `maxCapacity`, `readers`, `mode`                                                      |
| Valkey size and HA                                  | `valkey.nodeType`, `valkey.replicas`                                                                        |
| NAT                                                 | `vpc.nat.mode` (`fck-nat` or `gateway`), `vpc.nat.count`                                                    |
| WAF (rules in [security.md](security.md#waf-rules)) | `waf.enabled`, `waf.rateLimitPer5Min`, `waf.countRules`                                                     |
| Countries allowed through WAF                       | `waf.allowCountries` (default `[US]`, `[]` turns it off)                                                    |
| WAF rate limits (per IP, 5 min)                     | `waf.ocppRateLimitPer5Min`, `authRateLimitPer5Min`, `guestRateLimitPer5Min`, `adyenWebhookRateLimitPer5Min` |
| Stripe webhook addresses                            | `waf.stripeWebhookIps` (seed only, see `scripts/stripe-webhook-ips.sh`)                                     |
| Rotation                                            | `rotation.*Days`, `ecs.redeployEveryDays` (must be shorter)                                                 |
| Settings table values                               | `appSettings` (non-secret keys only)                                                                        |

Aurora readers are pinned to the availability zones after the first (`vpc.availabilityZones`), so an AZ outage leaves a reader running. The writer is never pinned, because setting its AZ would replace it. Pinning a reader that already exists in another AZ replaces that reader once, with no writer failover.

Stop a lower environment without deleting it: set `desiredCount: 0` on every service (with autoscaling, also `autoscaling.min: 0`) and deploy. With `aurora.minCapacity: 0`, Aurora pauses after `aurora.autoPauseSeconds` without connections, leaving the ALB, NAT, Valkey, and secrets as the idle cost.

## Credential rotation

Three credentials rotate. The static application keys (JWT, settings encryption, initial admin, Grafana admin) do not (EXC-003).

| Secret                                        | Rotated by                                                                              | Scheme                                                                                           |
| --------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `evtivity/<env>/db-master`                    | Secrets Manager hosted function (PostgreSQL single user)                                | Changes the `evtivity_admin` password in place                                                   |
| `evtivity/<env>/db-app`                       | Secrets Manager hosted function (PostgreSQL multi user)                                 | Alternates between `evtivity_app` and `evtivity_app_clone`, both members of `evtivity_app_group` |
| `evtivity/<env>/cache-<service>`, `cache-app` | `lambda/valkey-rotation.ts` (one function, the user comes from the secret's `user_arn`) | Keeps the current and new password on the Valkey user at the same time                           |

Settings:

```yaml
rotation:
  enabled: true # false removes the schedules; secrets keep their current values
  databaseDays: 30 # db-master and db-app
  cacheDays: 30 # cache-<service> and cache-app
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

### Conformance OCSP responder: `octt.ocspResponder`

Conformance (OCTT) runs started from the dashboard run in the worker. With this on, the worker starts the Test System OCSP responder on port 7110 during a run, `OCTT_OCSP_RESPONDER_URL` points the test certificates at `http://worker.<env>.evtivity.internal:7110/ocsp`, and the ocpp service may reach that port. The run adds the worker host to `pnc.ocsp.allowedPrivateHosts` while it runs. Off by default (TC_C_50, TC_C_51, TC_C_52, and TC_M_24 are then skipped). It needs exactly one worker task, so the synth fails with `services.worker.desiredCount` above 1 or autoscaling. dev turns it on.

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
