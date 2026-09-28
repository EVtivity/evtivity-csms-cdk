<p align="center">
  <img src="assets/evtivity-logo.svg" alt="EVtivity" width="80" height="80" />
</p>

<h1 align="center">EVtivity CSMS AWS CDK</h1>

<p align="center">
  <a href="https://github.com/EVtivity/evtivity-csms-cdk/actions/workflows/ci.yml"><img src="https://github.com/EVtivity/evtivity-csms-cdk/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/EVtivity/evtivity-csms-cdk/actions/workflows/release.yml"><img src="https://github.com/EVtivity/evtivity-csms-cdk/actions/workflows/release.yml/badge.svg" alt="Release" /></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/License-BUSL--1.1-blue.svg" alt="License: BUSL-1.1" /></a>
  <img src="https://img.shields.io/badge/AWS%20CDK-v2-FF9900.svg?logo=amazonwebservices&logoColor=white" alt="AWS CDK v2" />
  <img src="https://img.shields.io/badge/Node.js-22%2B-339933.svg?logo=nodedotjs&logoColor=white" alt="Node.js 22+" />
  <img src="https://img.shields.io/badge/cdk--nag-AwsSolutions-2E7D32.svg" alt="cdk-nag AwsSolutions" />
  <img src="https://img.shields.io/badge/AWS-Security%20Best%20Practices-DD344C.svg" alt="AWS Security Best Practices" />
</p>

Deploy [EVtivity CSMS](https://github.com/EVtivity/evtivity-csms), the open charging station management system, to your own AWS account. One YAML file per environment describes everything: sizing, which services run, domain names, security options, and monitoring. The same platform is also available for Kubernetes as a [Helm chart](https://github.com/EVtivity/evtivity-csms-helm).

## What you get

- **All CSMS services on ECS Fargate (ARM64):** the operator dashboard, driver portal, REST API, OCPP server, OCPI server, background worker, and an optional charging station simulator.
- **Managed data stores:** Aurora PostgreSQL Serverless v2 and ElastiCache Valkey, in isolated subnets, encrypted, with TLS required.
- **One load balancer for every service**, routed by hostname, with TLS certificates issued and renewed for you. An optional network load balancer passes OCPP security profile 3 (mutual TLS) straight to the OCPP server.
- **Automatic credential rotation** for the database and cache users, with no downtime.
- **Observability:** Prometheus, Loki, and Grafana with the same dashboards and alert rules as the Helm chart. Alerts go to an SNS topic you can subscribe to.
- **Security by default:** every container runs as a non-root user with a read-only filesystem, a web application firewall in qa and prod, and automated checks against the AWS Foundational Security Best Practices on every build.
- **Cost-aware sizing:** small lower environments (a NAT instance instead of NAT gateways, Spot capacity, a database that pauses when idle) and a highly available production layout.

## Environments

Three environments come ready to use. Each is one file in `config/`, and every value can be changed.

| Env    | Compute                                  | Database                                      | Cache                         | NAT             | WAF |
| ------ | ---------------------------------------- | --------------------------------------------- | ----------------------------- | --------------- | --- |
| `dev`  | 1 task per service, Fargate Spot         | Serverless v2, 0 to 2 ACU, pauses when idle   | t4g.micro, single node        | fck-nat         | off |
| `qa`   | 1 task per service, on-demand            | Serverless v2, 0.5 to 4 ACU                   | t4g.micro, single node        | fck-nat         | on  |
| `prod` | 2+ tasks per public service, autoscaling | Serverless v2, 1 to 16 ACU, writer and reader | t4g.medium, replica, failover | NAT gateway x 2 | on  |

Estimated monthly costs for each environment are in [`docs/cost-report.md`](docs/cost-report.md).

## Prerequisites

- An AWS account and credentials for it (`aws sso login --profile <name>` or an access key profile)
- Node.js 22 or later
- A domain with a Route 53 public hosted zone in the same account. The stacks only add records under it (for example `csms.dev.example.com`) and never change existing ones.

## Quick start

### 1. Configure the environment

Settings shared by everyone live in `config/<env>.yaml`. Values specific to your account go in `config/<env>.local.yaml`, which git ignores and which is merged on top:

```bash
git clone https://github.com/EVtivity/evtivity-csms-cdk.git
cd evtivity-csms-cdk
npm ci
cp config/dev.local.yaml.example config/dev.local.yaml
```

```yaml
# config/dev.local.yaml
account: '123456789012'
domain:
  apex: example.com
  hostedZoneId: Z0123456789ABCDEFGHIJ
initialAdmin:
  email: you@example.com
observability:
  grafana:
    allowedCidrs: ['203.0.113.10/32'] # who can open Grafana
```

Hostnames are `<service>.<subdomain>.<apex>`. With `domain.subdomain: dev` the dashboard is `csms.dev.example.com`. An empty subdomain gives `csms.example.com`. Every option is documented in [`lib/config/schema.ts`](lib/config/schema.ts). Common ones:

| Option                     | What it does                                                       |
| -------------------------- | ------------------------------------------------------------------ |
| `image.tag`                | The CSMS release to run, for example `0.1.22`                      |
| `services.<name>.enabled`  | Turn a service off (for example the simulator in prod)             |
| `services.<name>.hostname` | Rename a service's hostname                                        |
| `seedDemo.enabled`         | Load demo sites, stations, and sessions once (not allowed in prod) |
| `monitoring.alarmEmail`    | Email address that receives alerts                                 |
| `rotation.databaseDays`    | How often database credentials rotate                              |

### 2. Deploy

```bash
npm run typecheck && npm run lint && npm test                      # optional checks

npx cdk bootstrap aws://<account>/us-east-1 --profile <name>      # once per account and region
npm run synth -- --context env=dev                                 # preview the templates
npm run deploy -- --context env=dev --all --profile <name>
```

The first deploy takes about 30 minutes, mostly for the database and cache. During the deploy a one-time task applies database migrations, creates the application database user, creates the first admin, and writes settings. Services start only after it succeeds. If it fails, the deploy rolls back and the error names the log stream to read.

### 3. Sign in

The deploy prints each service URL. To list them again:

```bash
aws cloudformation describe-stacks --stack-name Evtivity-Dev-App --profile <name> \
  --query "Stacks[0].Outputs[?starts_with(OutputKey,'Url')].[OutputKey,OutputValue]" --output table
```

| Service         | URL (dev)                                              |
| --------------- | ------------------------------------------------------ |
| Dashboard       | https://csms.dev.example.com                           |
| Driver portal   | https://portal.dev.example.com                         |
| API             | https://api.dev.example.com (health: `/v1/health`)     |
| OCPP (stations) | wss://ocpp.dev.example.com/<stationId>                 |
| OCPI            | https://ocpi.dev.example.com                           |
| Grafana         | https://grafana.dev.example.com (allowlisted IPs only) |

The first dashboard admin is `initialAdmin.email`. Its password is generated during the deploy, and the dashboard asks you to change it at first sign-in:

```bash
aws secretsmanager get-secret-value --secret-id evtivity/dev/initial-admin \
  --query SecretString --output text --profile <name>
```

Grafana's user is `admin`, with the password in `evtivity/dev/grafana-admin`. Grafana answers only to allowlisted addresses. Change the list at any time without a deploy:

```bash
AWS_PROFILE=<name> ./scripts/grafana-access.sh dev add me     # also: list, remove <cidr>
```

## Operating

### Upgrade to a new CSMS release

Set `image.tag` to the new [CSMS release](https://github.com/EVtivity/evtivity-csms/releases) and run the deploy command again. Migrations run before any service updates. Each tagged release of this repository sets `image.tag` to the matching CSMS version.

### Logs, status, and shell access

```bash
# Service logs (api, ocpp, ocpi, csms, portal, worker, css, db-job, grafana, loki, prometheus)
aws logs tail /evtivity/dev/api --follow --profile <name>

# Running tasks and deployment state
aws ecs describe-services --cluster evtivity-dev --services evtivity-dev-api \
  --query 'services[0].[runningCount,desiredCount,deployments[0].rolloutState]' --profile <name>

# Open a shell in a task (on in dev and qa, needs the Session Manager plugin)
aws ecs execute-command --cluster evtivity-dev --task <task-id> --container app \
  --interactive --command sh --profile <name>
```

Shell sessions keep the read-only filesystem, so only `/tmp` is writable, and every session is logged to `/evtivity/<env>/ecs-exec`. The observability containers are named `grafana`, `loki`, and `prometheus` instead of `app`.

Grafana's EVtivity folder has dashboards for system metrics, business metrics, logs, and alerts.

### Pause or remove an environment

- **Pause:** set `desiredCount: 0` on every service and deploy. Compute stops billing and the database pauses when idle.
- **Remove:** `npm run destroy -- --context env=dev --all --profile <name>`. dev and qa delete all data. prod keeps a final database snapshot, its buckets, logs, and secrets.

## Documentation

- [Deployment guide](docs/deployment.md): every configuration option, credential rotation, observability, OCPP TLS, demo data, GitHub Actions
- [Security](docs/security.md): controls, credentials, network, and tagging
- [Compliance exceptions](docs/compliance-exceptions.md): the few AWS best-practice checks that are not met, and why
- [Cost report](docs/cost-report.md): estimated monthly cost per environment

## Contributing

Run `npm run typecheck && npm run lint && npm test` before opening a pull request. The tests synthesize every environment and check the security controls. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org).

## License

[BSL 1.1](LICENSE.md). The Change License is Apache 2.0, effective four years after each release.
