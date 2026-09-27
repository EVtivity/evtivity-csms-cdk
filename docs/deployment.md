# Deployment

## Prerequisites

- AWS credentials for the target account (for example `aws sso login --profile <name>`)
- Node.js 22 or later
- A Route 53 public hosted zone for the apex domain in the same account. The stacks add only subdomain records (`csms.dev.evtivity.com`, ...) and the ACM validation record. They never touch the apex or `www`.
- A published CSMS release on `ghcr.io/evtivity/evtivity-csms/*`. The images must include the credential-assembling entrypoint and the read-only nginx layout (0.1.20 or later).

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

Rotation runs on the Secrets Manager schedule (`rotation.databaseDays`, `rotation.cacheDays`). The previous credential stays valid for one interval, and every service is redeployed on a weekly schedule so tasks pick up the current value. See `docs/security.md`.

Test a rotation:

```bash
aws secretsmanager rotate-secret --secret-id evtivity/dev/db-app
aws secretsmanager rotate-secret --secret-id evtivity/dev/cache-app
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
- `deploy.yml` (manual): writes `config/<env>.local.yaml` from the repository variables `AWS_ACCOUNT_ID`, `HOSTED_ZONE_ID`, and `INITIAL_ADMIN_EMAIL` of the chosen GitHub environment, assumes `AWS_DEPLOY_ROLE_ARN` through OIDC, then diffs and deploys. Give the `prod` environment required reviewers.
