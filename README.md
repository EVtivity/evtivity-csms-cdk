# EVtivity CSMS - AWS CDK

AWS CDK infrastructure for the EVtivity Charging Station Management System. Companion to `evtivity-csms-helm` (Kubernetes). This repo runs the same platform on AWS: ECS Fargate (ARM64), Aurora PostgreSQL, ElastiCache Valkey, an ALB with WAF, and an optional NLB for OCPP mutual TLS.

## Layout

```
evtivity-csms-cdk/
├── bin/app.ts                  # entry: loads config for --context env=<env>, runs cdk-nag
├── lambda/
│   ├── loki-forwarder.ts       # CloudWatch Logs subscription -> Loki push API
│   ├── run-task.ts             # custom resource: runs the database job, waits for exit 0
│   └── valkey-rotation.ts      # Secrets Manager rotation for the Valkey RBAC user
├── lib/
│   ├── build-app.ts            # creates every stack for one environment
│   ├── catalog.ts              # fixed facts per service: image, ports, health, dependencies
│   ├── config/                 # zod schema and YAML loader (<env>.yaml + <env>.local.yaml)
│   ├── constructs/
│   │   ├── app-service.ts      # one Fargate service with ALB rule, Cloud Map, autoscaling
│   │   ├── db-job.ts           # migrations, roles, admin seed, settings as a deploy step
│   │   ├── monitoring.ts       # CloudWatch dashboard and alarms
│   │   ├── observability.ts    # Prometheus (AMP), Loki, Grafana, log forwarding
│   │   └── secure-bucket.ts    # S3 with the Security Hub defaults
│   ├── db-job-scripts.ts       # SQL and Node steps the database job runs
│   ├── nag-suppressions.ts     # every accepted cdk-nag finding, with its reason
│   ├── tagging.ts              # Environment, Service, Stack, CreatedDate, UpdatedDate tags
│   └── stacks/                 # network, domain, storage, data, alb, app
├── observability/grafana/      # dashboards and alert rules copied from the CSMS repo
├── scripts/                    # changelog generator, observability sync
├── test/compliance.test.ts     # synthesizes every env, asserts Security Hub controls
├── config/                     # dev.yaml, qa.yaml, prod.yaml (+ gitignored *.local.yaml)
└── docs/
    ├── deployment.md
    ├── security.md
    ├── compliance-exceptions.md
    └── cost-report.md
```

## Environments

| Env    | Compute                                  | Database                                      | Cache                         | NAT             | WAF |
| ------ | ---------------------------------------- | --------------------------------------------- | ----------------------------- | --------------- | --- |
| `dev`  | 1 task per service, Fargate Spot         | Serverless v2, 0 to 2 ACU, pauses when idle   | t4g.micro, single node        | fck-nat         | off |
| `qa`   | 1 task per service, on-demand            | Serverless v2, 0.5 to 4 ACU                   | t4g.micro, single node        | fck-nat         | on  |
| `prod` | 2+ tasks per public service, autoscaling | Serverless v2, 1 to 16 ACU, writer and reader | t4g.medium, replica, failover | NAT gateway x 2 | on  |

Every environment also runs the observability stack from the Helm chart (Prometheus, Loki, Grafana, with the same dashboards and alert rules). See [`docs/deployment.md`](docs/deployment.md#observability-observabilityenabled).

Hostnames: `<service>.<env>.<apex>` for dev and qa, `<service>.<apex>` for prod. Monthly costs are in [`docs/cost-report.md`](docs/cost-report.md).

## Quick start

```bash
npm ci
cp config/dev.local.yaml.example config/dev.local.yaml   # account, hosted zone id, admin email
npm run typecheck && npm run lint && npm test
npx cdk bootstrap aws://<account>/us-east-1              # once per account and region
npm run synth -- --context env=dev
npm run deploy -- --context env=dev --all
```

The database job (migrations, grants, admin seed, settings) runs during the deploy. Services start only after it succeeds. See [`docs/deployment.md`](docs/deployment.md).

## Configuration

Everything is in `config/<env>.yaml` and validated at synth. Every service can be turned off (`services.<name>.enabled: false`), and the schema rejects combinations that cannot work (for example csms without api). `config/<env>.local.yaml` holds account ids and personal overrides and is deep-merged on top.

The CSMS release workflow sets `image.tag` in all three configs on every tag. Synth needs no AWS credentials: availability zones and the fck-nat AMI are pinned in config.

## Security

- cdk-nag (AWS Solutions) runs on every synth. Unacknowledged findings fail it.
- `npm test` asserts the AWS Foundational Security Best Practices controls for dev, qa, and prod.
- Database and Valkey credentials rotate automatically. Services are redeployed weekly to pick them up.
- Accepted gaps are in [`docs/compliance-exceptions.md`](docs/compliance-exceptions.md). Details in [`docs/security.md`](docs/security.md).

## CI

- `.github/workflows/ci.yml` (pull requests): typecheck, lint, tests, and synth for every environment.
- `.github/workflows/deploy.yml` (manual): OIDC deploy of one environment. Prod requires reviewers.

Commits follow Conventional Commits. The husky `commit-msg` hook runs commitlint.

## License

[BSL 1.1](LICENSE.md). The Change License is Apache 2.0 effective four years after each release.
