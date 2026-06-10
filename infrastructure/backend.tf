# Terraform state backend.
#
# Remote state is REQUIRED before any shared/CI deploy: local state isn't
# locked, encrypted, or shared, so two applies can corrupt each other. It's
# left commented because the S3 bucket + lock table must exist BEFORE
# `terraform init` can use them — committing an active backend would break a
# fresh `terraform init` for anyone who hasn't bootstrapped it yet.
#
# Bootstrap once (names must be globally unique — adjust the bucket):
#
#   aws s3api create-bucket --bucket family-greenhouse-tfstate-<acct> --region us-east-1
#   aws s3api put-bucket-versioning --bucket family-greenhouse-tfstate-<acct> \
#     --versioning-configuration Status=Enabled
#   aws dynamodb create-table --table-name family-greenhouse-terraform-locks \
#     --attribute-definitions AttributeName=LockID,AttributeType=S \
#     --key-schema AttributeName=LockID,KeyType=HASH --billing-mode PAY_PER_REQUEST
#
# Then uncomment the block below (fill in the bucket) and run:
#   terraform init -migrate-state
#
terraform {
  backend "s3" {
    bucket = "family-greenhouse-tfstate-014248889144"
    # This is the PRODUCTION state key. Per-environment isolation is done at
    # init time, NOT here: staging runs `terraform init
    # -backend-config="key=staging/terraform.tfstate"` (see scripts/deploy.sh
    # + cd-staging.yml) so it gets its own state and can never apply onto prod.
    # Do not parameterize this default to anything other than the prod key, or
    # a plain `terraform init` for prod would target the wrong (empty) state.
    key            = "terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "family-greenhouse-terraform-locks"
  }
}
