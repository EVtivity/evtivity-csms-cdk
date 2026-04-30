# Deployment

## Prerequisites

- AWS account with admin or sufficiently scoped credentials
- Node.js 22+
- AWS CLI v2 configured (`aws sso login` or `aws configure`)
- Route 53 hosted zone for the apex domain (e.g., `evtivity.com`) in the same account

## One-time setup

### 1. Bootstrap CDK in your AWS account/region

```bash
npx cdk bootstrap aws://ACCOUNT_ID/us-east-1
```

### 2. Edit your environment config

Open `config/dev.yaml` (or `qa.yaml`, `prod.yaml`) and replace the placeholders:

- `account`: your 12-digit AWS account id
- `domain.apex`: your registered domain (e.g., `evtivity.com`)
- `domain.subdomain`: the subdomain for this env (`dev`, `qa`, `prod`)
- `domain.hostedZoneId` (optional): if you know it, supplying it skips the Route 53 lookup
- `services.<name>.imageTag`: container image tags (must exist on `ghcr.io/evtivity/*`)

After editing, delete `cdk.context.json` so CDK can populate it from your real account on the next synth. The committed file holds placeholder lookup values keyed to account `111111111111` and lets CI synth run without AWS credentials. Once you switch accounts, the cache keys no longer match and CDK will perform the real lookups.

### 3. Pre-create application secrets

The CDK creates infrastructure secrets (Aurora master credentials, Redis auth token, composed `database-url` and `redis-url`) automatically. The application also expects `jwt-secret` and `settings-encryption-key`. Create them with random values once per env:

```bash
aws secretsmanager create-secret --name evtivity/dev/jwt-secret --secret-string "$(openssl rand -base64 48)"
aws secretsmanager create-secret --name evtivity/dev/settings-encryption-key --secret-string "$(openssl rand -base64 48)"
```

(Repeat for qa and prod with their respective paths.)

## Deploy

### From your laptop

```bash
npm install
npm run typecheck

# preview
npm run synth -- --context env=dev

# deploy a single stack first to validate
npm run deploy -- --context env=dev Evtivity-Dev-Network

# then deploy everything
npm run deploy -- --context env=dev --all
```

Stack order matters; CDK figures it out from `addDependency()` calls in `bin/app.ts`. With `--all`, dependencies are deployed first.

### From GitHub Actions

The repo includes two workflows:

- `.github/workflows/ci.yml` runs on every PR: typecheck, lint, `cdk synth` for all three envs.
- `.github/workflows/deploy.yml` is `workflow_dispatch`-triggered. Choose env (dev/qa/prod) and (optional) stack pattern. Authenticates to AWS via OIDC.

GitHub Action prerequisites:
- An IAM role in your AWS account with a trust policy for the GitHub OIDC provider (`token.actions.githubusercontent.com`)
- The role ARN stored as a GitHub repository variable named `AWS_DEPLOY_ROLE_ARN`
- The `prod` environment configured with required reviewers in repo settings (manual approval gate)

## Run the database migration

After the first deploy, the migrate task is provisioned with `desiredCount: 0`. Run it on demand:

```bash
aws ecs run-task \
  --cluster evtivity-dev \
  --task-definition evtivity-dev-migrate \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-xxx],securityGroups=[sg-xxx],assignPublicIp=DISABLED}' \
  --region us-east-1
```

Or wire this as a CI step that fires on tag push.

## Create the initial admin user

After migrations succeed, run the migrate task again with the seed-admin override. The migrate image ships `packages/database/src/seed-admin.ts`; the override replaces the default `drizzle-kit migrate` command with `npm run seed:admin`. The script is idempotent (`ON CONFLICT DO NOTHING`).

For dev, pass the password inline:

```bash
aws ecs run-task \
  --cluster evtivity-dev \
  --task-definition evtivity-dev-migrate \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-xxx],securityGroups=[sg-xxx],assignPublicIp=DISABLED}' \
  --overrides '{
    "containerOverrides": [{
      "name": "app",
      "command": ["sh", "-c", "cd packages/database && npm run seed:admin"],
      "environment": [
        {"name": "INITIAL_ADMIN_EMAIL", "value": "admin@example.com"},
        {"name": "INITIAL_ADMIN_PASSWORD", "value": "change-me-on-first-login"}
      ]
    }]
  }' \
  --region us-east-1
```

For prod, do not pass the password as a plaintext override (it lands in the CloudTrail `RunTask` event). Instead, pre-create a Secrets Manager secret, add it to the migrate service's `secretsFromSecretsManager` map in `config/<env>.yaml`, and redeploy so the task execution role gains access:

```yaml
# config/prod.yaml
services:
  migrate:
    secretsFromSecretsManager:
      DATABASE_URL: evtivity/prod/database-url
      INITIAL_ADMIN_PASSWORD: evtivity/prod/initial-admin-password
```

```bash
aws secretsmanager create-secret \
  --name evtivity/prod/initial-admin-password \
  --secret-string "$(openssl rand -base64 24)"

npm run deploy -- --context env=prod Evtivity-Prod-Ecs

aws ecs run-task \
  --cluster evtivity-prod \
  --task-definition evtivity-prod-migrate \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-xxx],securityGroups=[sg-xxx],assignPublicIp=DISABLED}' \
  --overrides '{
    "containerOverrides": [{
      "name": "app",
      "command": ["sh", "-c", "cd packages/database && npm run seed:admin"],
      "environment": [{"name": "INITIAL_ADMIN_EMAIL", "value": "admin@example.com"}]
    }]
  }' \
  --region us-east-1
```

After the admin is seeded, remove `INITIAL_ADMIN_PASSWORD` from `secretsFromSecretsManager` and redeploy so subsequent migrate runs do not pull it.

The created admin has `mustResetPassword: true` and `hasAllSiteAccess: true`. First login forces a password change.

## Updating image versions

Edit `services.<name>.imageTag` in the relevant `config/<env>.yaml`, commit, and run `cdk deploy`. ECS rolls out the new task definition with circuit breaker rollback enabled.

## Optional features

These are gated by top-level config blocks. All default to disabled.

### OCPP TLS (SP3 mTLS) - `ocppTls.enabled`

Adds an internet-facing NLB on `ocppTls.port` (default 8443) with TCP passthrough so the OCPP server terminates TLS and reads client certificates for SP3 stations. Operator pre-creates a Secrets Manager secret with three JSON keys (`cert`, `key`, `ca`) holding the server cert chain, key, and CA in PEM:

```bash
aws secretsmanager create-secret --name evtivity/dev/ocpp-tls --secret-string "$(jq -n \
  --arg cert "$(cat tls.crt)" \
  --arg key "$(cat tls.key)" \
  --arg ca "$(cat ca.crt)" \
  '{cert:$cert, key:$key, ca:$ca}')"
```

Set `ocppTls.secretName` to that secret name. The `ocpp-tls.<subdomain>.<apex>` Route 53 record points at the NLB. The OCPP entrypoint materializes the PEMs to files at `/tmp/ocpp-tls/` and exports `OCPP_TLS_PORT/CERT/KEY/CA` so the OCPP server starts the TLS listener. SP0-SP2 stations continue to connect via the ALB on `ocpp.<subdomain>.<apex>`.

### CSS client cert - `cssTls.enabled`

Same shape as `ocppTls`. Mounts a client certificate to the simulator container so it can connect over SP3 mTLS for testing.

### Service Connect - `serviceConnect.enabled`

Provisions a private DNS namespace (default `csms.local`) and registers each enabled service. Pods reach each other at `<service>.<namespace>` (e.g. `api.csms.local`). The cluster-managed namespace is created automatically when `serviceConnect.enabled: true`.

To turn on inter-service mTLS, set both `tls.enabled: true` and `tls.privateCaArn`:

```yaml
serviceConnect:
  enabled: true
  namespace: csms.local
  tls:
    enabled: true
    privateCaArn: arn:aws:acm-pca:us-east-1:ACCOUNT:certificate-authority/UUID
```

Operator pre-creates the Private CA. Steps:

```bash
aws acm-pca create-certificate-authority \
  --certificate-authority-configuration '{
    "KeyAlgorithm": "RSA_2048",
    "SigningAlgorithm": "SHA256WITHRSA",
    "Subject": { "Organization": "EVtivity", "CommonName": "csms-internal-ca" }
  }' \
  --certificate-authority-type ROOT \
  --region us-east-1

# Note the returned CertificateAuthorityArn
# Sign and install the root cert (one-time, see AWS docs for full flow)
aws acm-pca get-certificate-authority-csr --certificate-authority-arn $CA_ARN --output text > csr.pem
# ...issue and import the root cert via the AWS console or CLI...

# Then paste the ARN into config/<env>.yaml.
```

Cost note: AWS Private CA is ~$400/month per CA plus per-certificate issuance fees. For dev/qa, leave TLS off and rely on VPC + SG isolation. Enable in prod only when you have a compliance driver.

Without a PCA ARN, `serviceConnect.enabled: true` still gives DNS-based service discovery (no encryption), which is the most operationally useful piece.

### Monitoring - `monitoring.enabled`

Adds an `Evtivity-<Env>-Monitoring` stack with:

- A CloudWatch dashboard (`evtivity-<env>`) with widgets for ECS service CPU/memory, ALB request count and 5xx, target latency p95, Aurora ACU and connections, Redis CPU and cache hit rate.
- An Amazon Managed Prometheus workspace for Prometheus-style scraping. Wire Amazon Managed Grafana to the workspace separately (AMG is account-level and requires SSO setup).

CloudWatch Container Insights is on by default in the cluster regardless.

## Tearing down

```bash
npm run destroy -- --context env=dev --all
```

Aurora and S3 buckets in dev/qa are configured with `RemovalPolicy.DESTROY` and `autoDeleteObjects: true`, so they go away. Prod retains them by design. Manually delete prod resources from the console if you need to.
