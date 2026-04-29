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

## Updating image versions

Edit `services.<name>.imageTag` in the relevant `config/<env>.yaml`, commit, and run `cdk deploy`. ECS rolls out the new task definition with circuit breaker rollback enabled.

## Tearing down

```bash
npm run destroy -- --context env=dev --all
```

Aurora and S3 buckets in dev/qa are configured with `RemovalPolicy.DESTROY` and `autoDeleteObjects: true`, so they go away. Prod retains them by design. Manually delete prod resources from the console if you need to.
