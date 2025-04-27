![image info](logo-small.jpeg)

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

---

## How it works

This GitHub Action follows these steps to perform Terraform commands:

1. Runs terraform init to initialize the Terraform working directory.

2. Runs terraform validate to ensure the configuration is syntactically valid.

3. Runs terraform plan

4. On push to main it runs terraform apply automatically without prompting.

## Features

✔️ Automated Terraform Formatting: Ensures your code is properly formatted automatically.

✔️ Secure AWS Access: Uses AWS OIDC role assumption for secure and short-lived authentication.

✔️ PR Commenting: Posts Terraform plan outputs directly on your Pull Requests.

✔️ Auto Apply on Main: Automatically applies Terraform changes when pushing to the main branch.

✔️ Git Auto-commit: Auto-commits any required Terraform formatting fixes.

✔️ Detailed Plan Reporting: Summarizes all Terraform steps (format, init, validate, plan) in a structured PR comment.


## Inputs

- `working_directory`: The directory where Terraform files are located (default: `./`)
- `environment`: The environment name (e.g., `dev`, `prod`) (required)
- `aws_region`: AWS Region to use for Terraform (required)
- `aws_role`: IAM role ARN to assume for AWS credentials (required)
- `aws_account_id`: AWS account ID (required)
- `github_token`: GitHub token for the running (required)

## 🚀 Usage

```yaml
name: Terraform Global
on:
  push:
    branches: ['main']
    paths: ['global/**', 'modules/**']
  pull_request:
    paths: ['global/**', 'modules/**']

jobs:
  deploy:
    uses: delivops/terraform-action@0.0.2
    with:
        working_directory: "global"
        github_token: ${{ secrets.GITHUB_TOKEN }}
        aws_account_id: ${{ secrets.AWS_ACCOUNT_ID }}
        environment: "Global"
        aws_region: ${{ secrets.AWS_DEFAULT_REGION }}
        aws_role: "github_terraform"
