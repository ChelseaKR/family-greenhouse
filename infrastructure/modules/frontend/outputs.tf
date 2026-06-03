output "frontend_bucket_name" {
  description = "Frontend S3 bucket name"
  value       = aws_s3_bucket.frontend.id
}

output "frontend_bucket_arn" {
  description = "Frontend S3 bucket ARN"
  value       = aws_s3_bucket.frontend.arn
}

output "images_bucket_name" {
  description = "Images S3 bucket name"
  value       = aws_s3_bucket.images.id
}

output "images_bucket_arn" {
  description = "Images S3 bucket ARN"
  value       = aws_s3_bucket.images.arn
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID"
  value       = aws_cloudfront_distribution.frontend.id
}

output "cloudfront_arn" {
  description = "CloudFront distribution ARN"
  value       = aws_cloudfront_distribution.frontend.arn
}

output "cloudfront_url" {
  description = "CloudFront distribution URL"
  value       = "https://${aws_cloudfront_distribution.frontend.domain_name}"
}

output "site_url" {
  description = "User-facing site URL (custom domain if set, else CloudFront)"
  value       = var.domain_name == "" ? "https://${aws_cloudfront_distribution.frontend.domain_name}" : "https://${var.domain_name}"
}
