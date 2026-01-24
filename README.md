[![DelivOps banner](https://raw.githubusercontent.com/delivops/.github/main/images/banner.png?raw=true)](https://delivops.com)

# Terraform GitHub Action

![Terraform](https://img.shields.io/badge/Terraform-Global-blueviolet)  

**Fully automated Terraform CI/CD pipeline for global infrastructure.**

This GitHub Action automatically:
- Formats Terraform files (`terraform fmt`)
- Initializes Terraform (`terraform init`)
- Validates Terraform files (`terraform validate`)
- Generates a Terraform plan (`terraform plan`)
- Comments the validation and plan results directly on pull requests
- Applies Terraform changes on `main` branch push (`terraform apply`)
- Optionally estimates infrastructure costs with Infracost

---

## How it works

This GitHub Action follows these steps to perform Terraform commands:

1. **Validates inputs** - Ensures AWS account ID, region, and other inputs are properly formatted
2. **Runs terraform fmt** - Checks code formatting in the working directory
3. **Runs terraform init** - Initializes the Terraform working directory
4. **Runs terraform validate** - Ensures the configuration is syntactically valid
5. **Runs terraform plan** - Generates an execution plan (on PRs)
6. **Runs Infracost** - Estimates costs if enabled (on PRs)
7. **Comments on PR** - Posts formatted results directly on the pull request
8. **Runs terraform apply** - Automatically applies changes on main branch push

## Features

✔️ **Automated Terraform Formatting**: Checks your code formatting automatically.

✔️ **Secure AWS Access**: Uses AWS OIDC role assumption for secure and short-lived authentication.

✔️ **PR Commenting**: Posts Terraform plan outputs directly on your Pull Requests.

✔️ **Auto Apply on Main**: Automatically applies Terraform changes when pushing to the main branch.

✔️ **Cost Estimation**: Optional Infracost integration for infrastructure cost visibility.

✔️ **Detailed Plan Reporting**: Summarizes all Terraform steps (format, init, validate, plan) in a structured PR comment.

✔️ **Input Validation**: Validates AWS account ID and region format before execution.

✔️ **Flexible Configuration**: Supports var files, extra arguments, and plan-only mode.

---

## Prerequisites

### AWS OIDC Setup

This action uses AWS OIDC for secure authentication. You need to:

1. **Create an OIDC Identity Provider** in your AWS account:
   - Provider URL: `https://token.actions.githubusercontent.com`
   - Audience: `sts.amazonaws.com`

2. **Create an IAM Role** with a trust policy for GitHub Actions:

\`\`\`json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::YOUR_ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:YOUR_ORG/YOUR_REPO:*"
        }
      }
    }
  ]
}
\`\`\`

3. **Attach the necessary permissions** to the IAM role for your Terraform operations.

---

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| \`working_directory\` | ✅ | - | Directory containing Terraform configuration |
| \`environment\` | ✅ | - | Environment name (e.g., \`dev\`, \`staging\`, \`prod\`) |
| \`aws_region\` | ✅ | - | AWS Region (e.g., \`us-east-1\`, \`eu-west-1\`) |
| \`aws_role\` | ✅ | - | IAM role name to assume for AWS credentials |
| \`aws_account_id\` | ✅ | - | AWS Account ID (12-digit number) |
| \`github_token\` | ✅ | - | GitHub token for PR comments |
| \`terraform_version\` | ❌ | \`1.9.8\` | Terraform version to install |
| \`var_file\` | ❌ | - | Path to a \`.tfvars\` file (relative to working_directory) |
| \`extra_args\` | ❌ | - | Additional arguments for terraform plan/apply |
| \`plan_only\` | ❌ | \`false\` | Skip apply even on main branch push |
| \`enable_cost_estimation\` | ❌ | \`false\` | Enable Infracost cost estimation |
| \`infracost_api_key\` | ❌ | - | Infracost API key (required if cost estimation enabled) |

## Outputs

| Output | Description |
|--------|-------------|
| \`fmt_outcome\` | Outcome of terraform fmt check (\`success\`/\`failure\`) |
| \`validate_outcome\` | Outcome of terraform validate (\`success\`/\`failure\`) |
| \`plan_outcome\` | Outcome of terraform plan (\`success\`/\`failure\`/\`skipped\`) |
| \`apply_outcome\` | Outcome of terraform apply (\`success\`/\`failure\`/\`skipped\`) |

---

## Required Permissions

Your workflow must have the following permissions:

\`\`\`yaml
permissions:
  id-token: write      # Required for AWS OIDC authentication
  contents: read       # Required for checkout
  pull-requests: write # Required for PR comments
\`\`\`

---

## 🚀 Usage

### Basic Usage

\`\`\`yaml
name: Terraform
on:
  push:
    branches: ['main']
    paths: ['infrastructure/**']
  pull_request:
    paths: ['infrastructure/**']

permissions:
  id-token: write
  contents: read
  pull-requests: write

jobs:
  terraform:
    runs-on: ubuntu-latest
    steps:
      - uses: delivops/terraform-action@v1
        with:
          working_directory: "infrastructure"
          github_token: \${{ secrets.GITHUB_TOKEN }}
          aws_account_id: \${{ secrets.AWS_ACCOUNT_ID }}
          environment: "production"
          aws_region: "us-east-1"
          aws_role: "github_terraform"
\`\`\`

### With Cost Estimation

\`\`\`yaml
jobs:
  terraform:
    runs-on: ubuntu-latest
    steps:
      - uses: delivops/terraform-action@v1
        with:
          working_directory: "infrastructure"
          github_token: \${{ secrets.GITHUB_TOKEN }}
          aws_account_id: \${{ secrets.AWS_ACCOUNT_ID }}
          environment: "production"
          aws_region: "us-east-1"
          aws_role: "github_terraform"
          enable_cost_estimation: true
          infracost_api_key: \${{ secrets.INFRACOST_API_KEY }}
\`\`\`

> 💡 Get your free Infracost API key at [infracost.io](https://www.infracost.io/)

### With Variable File

\`\`\`yaml
jobs:
  terraform:
    runs-on: ubuntu-latest
    steps:
      - uses: delivops/terraform-action@v1
        with:
          working_directory: "infrastructure"
          github_token: \${{ secrets.GITHUB_TOKEN }}
          aws_account_id: \${{ secrets.AWS_ACCOUNT_ID }}
          environment: "production"
          aws_region: "us-east-1"
          aws_role: "github_terraform"
          var_file: "production.tfvars"
\`\`\`

### Plan Only (No Auto-Apply)

\`\`\`yaml
jobs:
  terraform:
    runs-on: ubuntu-latest
    steps:
      - uses: delivops/terraform-action@v1
        with:
          working_directory: "infrastructure"
          github_token: \${{ secrets.GITHUB_TOKEN }}
          aws_account_id: \${{ secrets.AWS_ACCOUNT_ID }}
          environment: "production"
          aws_region: "us-east-1"
          aws_role: "github_terraform"
          plan_only: true
\`\`\`

### Multi-Environment Matrix

\`\`\`yaml
name: Terraform Multi-Environment
on:
  push:
    branches: ['main']
  pull_request:

permissions:
  id-token: write
  contents: read
  pull-requests: write

jobs:
  terraform:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        include:
          - environment: dev
            working_directory: environments/dev
            aws_role: github_terraform_dev
          - environment: staging
            working_directory: environments/staging
            aws_role: github_terraform_staging
          - environment: prod
            working_directory: environments/prod
            aws_role: github_terraform_prod
    steps:
      - uses: delivops/terraform-action@v1
        with:
          working_directory: \${{ matrix.working_directory }}
          github_token: \${{ secrets.GITHUB_TOKEN }}
          aws_account_id: \${{ secrets.AWS_ACCOUNT_ID }}
          environment: \${{ matrix.environment }}
          aws_region: "us-east-1"
          aws_role: \${{ matrix.aws_role }}
\`\`\`

### Using Outputs

\`\`\`yaml
jobs:
  terraform:
    runs-on: ubuntu-latest
    steps:
      - uses: delivops/terraform-action@v1
        id: terraform
        with:
          working_directory: "infrastructure"
          github_token: \${{ secrets.GITHUB_TOKEN }}
          aws_account_id: \${{ secrets.AWS_ACCOUNT_ID }}
          environment: "production"
          aws_region: "us-east-1"
          aws_role: "github_terraform"
      
      - name: Check Outputs
        run: |
          echo "Format: \${{ steps.terraform.outputs.fmt_outcome }}"
          echo "Validate: \${{ steps.terraform.outputs.validate_outcome }}"
          echo "Plan: \${{ steps.terraform.outputs.plan_outcome }}"
          echo "Apply: \${{ steps.terraform.outputs.apply_outcome }}"
\`\`\`

---

## License

MIT
