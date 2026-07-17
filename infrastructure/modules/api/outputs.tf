output "api_url" {
  description = "API Gateway URL"
  value       = "${aws_apigatewayv2_api.main.api_endpoint}/${var.environment}"
}

output "api_gateway_name" {
  description = "API Gateway name"
  value       = aws_apigatewayv2_api.main.name
}

output "api_gateway_id" {
  description = "HTTP API Gateway ID used by CloudWatch's ApiId dimension"
  value       = aws_apigatewayv2_api.main.id
}

output "api_access_log_group_name" {
  description = "CloudWatch log group containing structured HTTP API access logs"
  value       = aws_cloudwatch_log_group.api_gateway.name
}

output "api_lambda_log_group_name" {
  description = "CloudWatch log group for the API/telemetry Lambda"
  value       = aws_cloudwatch_log_group.lambda["api"].name
}

output "auth_lambda_log_group_name" {
  description = "CloudWatch log group for the authentication Lambda"
  value       = aws_cloudwatch_log_group.lambda["auth"].name
}

output "api_gateway_arn" {
  description = "API Gateway ARN"
  value       = aws_apigatewayv2_api.main.arn
}

output "api_gateway_endpoint" {
  description = "API Gateway base endpoint (https://<id>.execute-api.<region>.amazonaws.com), no stage path"
  value       = aws_apigatewayv2_api.main.api_endpoint
}

output "lambda_function_names" {
  description = "Lambda function names (handler fleet + the standalone chat-stream function, so monitoring covers it too)"
  value = concat(
    [for k, v in aws_lambda_function.handlers : v.function_name],
    [aws_lambda_function.chat_stream.function_name],
  )
}

output "chat_stream_function_url" {
  description = "Lambda Function URL for streaming chat (SSE, in-handler JWT auth). Feed to the frontend build as VITE_CHAT_STREAM_URL to enable streaming; unset keeps the sync /chat/messages path."
  value       = aws_lambda_function_url.chat_stream.function_url
}

output "chat_stream_function_name" {
  description = "Name of the streaming chat Lambda (CD updates its code alongside the fleet)."
  value       = aws_lambda_function.chat_stream.function_name
}

output "lambda_dlq_name" {
  description = "Name of the Lambda/EventBridge dead-letter queue (monitoring alarms on its depth)."
  value       = aws_sqs_queue.lambda_dlq.name
}
