output "api_url" {
  description = "API Gateway URL"
  value       = "${aws_apigatewayv2_api.main.api_endpoint}/${var.environment}"
}

output "api_gateway_name" {
  description = "API Gateway name"
  value       = aws_apigatewayv2_api.main.name
}

output "api_gateway_arn" {
  description = "API Gateway ARN"
  value       = aws_apigatewayv2_api.main.arn
}

output "lambda_function_names" {
  description = "Lambda function names"
  value       = [for k, v in aws_lambda_function.handlers : v.function_name]
}
