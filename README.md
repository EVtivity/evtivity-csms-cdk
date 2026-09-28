# EVtivity CSMS - AWS CDK

<p>
  <a href="https://github.com/EVtivity/evtivity-csms-cdk/actions/workflows/ci.yml"><img src="https://github.com/EVtivity/evtivity-csms-cdk/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/EVtivity/evtivity-csms-cdk/actions/workflows/release.yml"><img src="https://github.com/EVtivity/evtivity-csms-cdk/actions/workflows/release.yml/badge.svg" alt="Release" /></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/License-BUSL--1.1-blue.svg" alt="License: BUSL-1.1" /></a>
  <img src="https://img.shields.io/badge/AWS%20CDK-v2-FF9900.svg?logo=amazonwebservices&logoColor=white" alt="AWS CDK v2" />
  <img src="https://img.shields.io/badge/Node.js-22%2B-339933.svg?logo=nodedotjs&logoColor=white" alt="Node.js 22+" />
  <img src="https://img.shields.io/badge/cdk--nag-AwsSolutions-2E7D32.svg" alt="cdk-nag AwsSolutions" />
  <img src="https://img.shields.io/badge/Security%20Hub-FSBP-DD344C.svg" alt="Security Hub FSBP" />
</p>

AWS CDK infrastructure for the EVtivity Charging Station Management System. Companion to `evtivity-csms-helm` (Kubernetes). This repo runs the same platform on AWS: ECS Fargate (ARM64), Aurora PostgreSQL, ElastiCache Valkey, an ALB with WAF, Prometheus, Loki, and Grafana, and an optional NLB for OCPP mutual TLS.

## Environments

| Env    | Compute                                  | Database                                      | Cache                         | NAT             | WAF |
| ------ | ---------------------------------------- | --------------------------------------------- | ----------------------------- | --------------- | --- |
| `dev`  | 1 task per service, Fargate Spot         | Serverless v2, 0 to 2 ACU, pauses when idle   | t4g.micro, single node        | fck-nat         | off |
| `qa`   | 1 task per service, on-demand            | Serverless v2, 0.5 to 4 ACU                   | t4g.micro, single node        | fck-nat         | on  |
| `prod` | 2+ tasks per public service, autoscaling | Serverless v2, 1 to 16 ACU, writer and reader | t4g.medium, replica, failover | NAT gateway x 2 | on  |

Every environment runs the observability stack from the Helm chart (Prometheus, Loki, Grafana, with the same dashboards and alert rules). Monthly costs are in [`docs/cost-report.md`](docs/cost-report.md).

## Deploy

### Prerequisites

- AWS credentials for the target account (`aws sso login --profile <name>` or an access key profile)
- Node.js 22 or later
- A Route 53 public hosted zone for the domain (for example `[your-domain].com`) in the same account
- The CSMS release set in `image.tag` published on `ghcr.io/evtivity/evtivity-csms/*` (the CSMS release workflow updates `image.tag` in every config)

### 1. Configure the environment

`config/<env>.yaml` holds the committed settings. Account-specific values go in `config/<env>.local.yaml` (gitignored), which is merged on top:

```bash
cp config/dev.local.yaml.example config/dev.local.yaml
```

```yaml
# config/dev.local.yaml
account: '123456789012'
domain:
  hostedZoneId: Z0123456789ABCDEFGHIJ
initialAdmin:
  email: you@example.com
observability:
  grafana:
    allowedCidrs: ['203.0.113.10/32'] # initial Grafana allowlist
```

Hostnames are `<hostname>.<subdomain>.<apex>`: `domain.subdomain: dev` gives `csms.dev.[your-domain].com`, and prod's empty subdomain gives `csms.[your-domain].com`. Rename a service with `services.<name>.hostname`. Turn a service off with `services.<name>.enabled: false`. Every option is documented in [`lib/config/schema.ts`](lib/config/schema.ts).

### 2. Check and deploy

```bash
npm ci
npm run typecheck && npm run lint && npm test

npx cdk bootstrap aws://<account>/us-east-1 --profile <name>      # once per account and region
npm run synth -- --context env=dev                                 # renders templates, runs cdk-nag
npm run deploy -- --context env=dev --all --profile <name>
```

A first deploy takes about 30 minutes, mostly Aurora and Valkey. During the App stack deploy a one-shot task runs migrations, creates the application database role, seeds the first admin, and writes settings. Services start only after it exits successfully. If it fails, CloudFormation rolls the App stack back and the error names the log stream.

To update: change the config (or let the release workflow change `image.tag`) and run the same deploy command. To deploy a single stack, name it, for example `Evtivity-Dev-App`.

## View the services

### URLs

The App stack prints them as outputs:

```bash
aws cloudformation describe-stacks --stack-name Evtivity-Dev-App --profile <name> \
  --query "Stacks[0].Outputs[?starts_with(OutputKey,'Url')].[OutputKey,OutputValue]" --output table
```

| Service         | dev URL                                                      |
| --------------- | ------------------------------------------------------------ |
| Dashboard       | https://csms.dev.[your-domain].com                           |
| Driver portal   | https://portal.dev.[your-domain].com                         |
| API             | https://api.dev.[your-domain].com (health: `/v1/health`)     |
| OCPP (stations) | wss://ocpp.dev.[your-domain].com/<stationId>                 |
| OCPI            | https://ocpi.dev.[your-domain].com                           |
| Grafana         | https://grafana.dev.[your-domain].com (allowlisted IPs only) |

### Sign in

The first dashboard admin is `initialAdmin.email`. The password is generated at deploy time, and the dashboard asks for a new one at first sign-in:

```bash
aws secretsmanager get-secret-value --secret-id evtivity/dev/initial-admin \
  --query SecretString --output text --profile <name>
```

Grafana's user is `admin`. Its password is in `evtivity/dev/grafana-admin`.

Grafana answers only to allowlisted addresses. Change the list at any time without a deploy:

```bash
AWS_PROFILE=<name> ./scripts/grafana-access.sh dev add me     # also: list, remove <cidr>
```

### Logs and status

```bash
# Service logs (api, ocpp, ocpi, csms, portal, worker, css, db-job, grafana, loki, prometheus)
aws logs tail /evtivity/dev/api --follow --profile <name>

# Running tasks and deployment state
aws ecs describe-services --cluster evtivity-dev --services evtivity-dev-api \
  --query 'services[0].[runningCount,desiredCount,deployments[0].rolloutState]' --profile <name>

# Shell into a task (dev and qa have ECS Exec enabled, needs the Session Manager plugin)
aws ecs execute-command --cluster evtivity-dev --task <task-id> --container app \
  --interactive --command sh --profile <name>
```

Exec sessions run as root and keep the read-only root filesystem, so only `/tmp` is writable. Every session is logged to `/evtivity/<env>/ecs-exec`. The observability containers are named `grafana`, `loki`, and `prometheus` instead of `app`.

In Grafana, the EVtivity folder holds the system metrics, business metrics, logs, and alerts dashboards. Alerts publish to the `evtivity-dev-alerts` SNS topic. Set `monitoring.alarmEmail` to receive them by email.

### Stop or remove an environment

- Pause: set `desiredCount: 0` on every service and deploy. Aurora pauses when idle and compute stops billing.
- Remove: `npm run destroy -- --context env=dev --all --profile <name>`. The dev and qa settings delete all data. Prod retains its database snapshot, buckets, logs, and secrets.

## More

- [`docs/deployment.md`](docs/deployment.md): configuration reference, rotation, observability, OCPP TLS, GitHub Actions
- [`docs/security.md`](docs/security.md): controls, credentials, network, tags
- [`docs/compliance-exceptions.md`](docs/compliance-exceptions.md): accepted Security Hub gaps
- [`docs/cost-report.md`](docs/cost-report.md): monthly cost per environment

cdk-nag runs on every synth and `npm test` asserts the Security Hub controls for every environment. Commits follow Conventional Commits.

## License

[BSL 1.1](LICENSE.md). The Change License is Apache 2.0 effective four years after each release.
