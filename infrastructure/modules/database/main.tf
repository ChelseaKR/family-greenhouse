resource "aws_dynamodb_table" "main" {
  name         = "${var.project_name}-${var.environment}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }

  attribute {
    name = "GSI1PK"
    type = "S"
  }

  attribute {
    name = "GSI1SK"
    type = "S"
  }

  attribute {
    name = "GSI2PK"
    type = "S"
  }

  attribute {
    name = "GSI2SK"
    type = "S"
  }

  # GSI1: Tasks by due date
  global_secondary_index {
    name            = "GSI1"
    hash_key        = "GSI1PK"
    range_key       = "GSI1SK"
    projection_type = "ALL"
  }

  # GSI2: Tasks by assignee
  global_secondary_index {
    name            = "GSI2"
    hash_key        = "GSI2PK"
    range_key       = "GSI2SK"
    projection_type = "ALL"
  }

  # TTL for invite links
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  # Point-in-time recovery in every environment. Continuous backups are a few
  # cents/month for a table this size, and the protection (recover from a bad
  # migration, an errant batch delete, or a bug that corrupts rows) is worth it
  # in staging too — staging increasingly holds real-shaped data used to
  # validate releases, and "it's only staging" is exactly when an unrecoverable
  # mistake hurts.
  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  tags = {
    Name = "${var.project_name}-table-${var.environment}"
  }
}
