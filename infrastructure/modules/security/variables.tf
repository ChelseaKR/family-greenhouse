variable "environment" {
  description = "Environment name"
  type        = string
}

variable "project_name" {
  description = "Project name"
  type        = string
}

variable "api_gateway_arn" {
  description = "API Gateway ARN"
  type        = string
}

variable "api_gateway_stage_arn" {
  description = "API Gateway stage ARN — the resource the WAF web ACL associates with"
  type        = string
}

variable "cloudfront_arn" {
  description = "CloudFront distribution ARN"
  type        = string
}
