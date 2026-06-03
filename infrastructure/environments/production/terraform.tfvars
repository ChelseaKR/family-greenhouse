environment        = "production"
aws_region         = "us-east-1"
project_name       = "family-greenhouse"
domain_name        = "familygreenhouse.net"
alert_email        = "support@familygreenhouse.net"
email_from_address = "Family Greenhouse <hello@familygreenhouse.net>"
email_reply_to     = "support@familygreenhouse.net"
dmarc_rua_email    = "dmarc@familygreenhouse.net"

# Perenual: only the secret NAME goes through Terraform. The actual API key
# was put into Secrets Manager via the AWS CLI and is never tracked by IAC.
perenual_api_key_secret_id = "family-greenhouse/perenual-api-key"
