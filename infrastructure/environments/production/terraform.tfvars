environment        = "production"
aws_region         = "us-east-1"
project_name       = "family-greenhouse"
domain_name        = "familygreenhouse.net"
alert_email        = "ckellyreif@gmail.com"
email_from_address = "Family Greenhouse <hello@familygreenhouse.net>"
email_reply_to     = "support@familygreenhouse.net"
dmarc_rua_email    = "dmarc@familygreenhouse.net"

# Perenual: only the secret NAME goes through Terraform. The actual API key
# was put into Secrets Manager via the AWS CLI and is never tracked by IAC.
perenual_api_key_secret_id = "family-greenhouse/perenual-api-key"

# CI/CD: provisions the GitHub OIDC provider + deploy role (modules/cicd).
# The role ARN goes into the AWS_DEPLOY_ROLE_ARN + AWS_PRODUCTION_ROLE_ARN
# repo secrets. Trust is bound to this repo's main branch + v* tags +
# the 'production' GitHub environment.
github_org  = "ChelseaKR"
github_repo = "family-greenhouse"
