output "frontend_url" {
  description = "CloudFront distribution URL"
  value       = module.frontend.cloudfront_url
}

output "site_url" {
  description = "User-facing site URL (custom domain if set, else CloudFront)"
  value       = module.frontend.site_url
}

output "api_url" {
  description = "API Gateway URL"
  value       = module.api.api_url
}

output "cognito_user_pool_id" {
  description = "Cognito User Pool ID"
  value       = module.auth.user_pool_id
}

output "cognito_client_id" {
  description = "Cognito App Client ID"
  value       = module.auth.client_id
}

output "dynamodb_table_name" {
  description = "DynamoDB table name"
  value       = module.database.table_name
}

output "images_bucket_name" {
  description = "S3 bucket for plant images"
  value       = module.frontend.images_bucket_name
}

output "frontend_bucket_name" {
  description = "S3 bucket for frontend assets"
  value       = module.frontend.frontend_bucket_name
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID"
  value       = module.frontend.cloudfront_distribution_id
}

output "github_deploy_role_arn" {
  description = "Deploy role ARN for GitHub Actions OIDC. Populates the AWS_PRODUCTION_ROLE_ARN repo secret."
  value       = length(module.cicd) > 0 ? module.cicd[0].deploy_role_arn : ""
}
