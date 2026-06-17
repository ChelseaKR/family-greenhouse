terraform {
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      configuration_aliases = [aws, aws.us_east_1]
    }
  }
}

# Frontend S3 Bucket
resource "aws_s3_bucket" "frontend" {
  bucket = "${var.project_name}-frontend-${var.environment}-${random_id.bucket_suffix.hex}"

  tags = {
    Name = "${var.project_name}-frontend-${var.environment}"
  }
}

resource "random_id" "bucket_suffix" {
  byte_length = 4
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  versioning_configuration {
    status = var.environment == "production" ? "Enabled" : "Suspended"
  }
}

# Versioning without lifecycle = unbounded growth: every `aws s3 sync
# --delete` deploy turns the previous build's hashed assets into noncurrent
# versions that would otherwise live forever. 30 days of noncurrent history
# is ample rollback window for static frontend builds.
resource "aws_s3_bucket_lifecycle_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  # Noncurrent-version rules only make sense once versioning is configured;
  # the provider docs recommend the explicit ordering.
  depends_on = [aws_s3_bucket_versioning.frontend]

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Images S3 Bucket
resource "aws_s3_bucket" "images" {
  bucket = "${var.project_name}-images-${var.environment}-${random_id.bucket_suffix.hex}"

  tags = {
    Name = "${var.project_name}-images-${var.environment}"
  }
}

resource "aws_s3_bucket_public_access_block" "images" {
  bucket = aws_s3_bucket.images.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Versioning enabled in production to match the frontend bucket — gives a
# recovery window for an accidentally overwritten/deleted plant photo. Paired
# with the lifecycle rule below so noncurrent versions don't accumulate forever.
resource "aws_s3_bucket_versioning" "images" {
  bucket = aws_s3_bucket.images.id

  versioning_configuration {
    status = var.environment == "production" ? "Enabled" : "Suspended"
  }
}

# Lifecycle for the images bucket (previously absent — deleted-plant photos and
# abandoned presigned-PUT uploads would otherwise live forever: cost creep plus
# a data-retention gap where user images persist after account deletion).
#   - abort_incomplete_multipart_upload: reclaim never-finished presigned PUTs.
#   - noncurrent_version_expiration: bound the versioning history added above.
resource "aws_s3_bucket_lifecycle_configuration" "images" {
  bucket = aws_s3_bucket.images.id

  # Noncurrent-version rules only make sense once versioning is configured.
  depends_on = [aws_s3_bucket_versioning.images]

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

resource "aws_s3_bucket_cors_configuration" "images" {
  bucket = aws_s3_bucket.images.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["PUT", "GET"]
    # Presigned-PUT uploads come from the browser on the site origin only.
    # Pin CORS to that origin instead of "*" (which let any site script the
    # cross-origin upload). Falls back to "*" only in the no-domain dev
    # environment, where there is no stable site origin to pin to.
    allowed_origins = var.domain_name == "" ? ["*"] : ["https://${var.domain_name}", "https://www.${var.domain_name}"]
    max_age_seconds = 3600
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "images" {
  bucket = aws_s3_bucket.images.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# CloudFront Origin Access Control
resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${var.project_name}-frontend-oac-${var.environment}"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# CloudFront Distribution
resource "aws_cloudfront_distribution" "frontend" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  comment             = "${var.project_name} ${var.environment}"

  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = "S3-frontend"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  origin {
    domain_name              = aws_s3_bucket.images.bucket_regional_domain_name
    origin_id                = "S3-images"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "S3-frontend"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    cache_policy_id          = aws_cloudfront_cache_policy.frontend.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.cors_s3.id

    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  # Cache behavior for plant photos. S3 keys in the images bucket are
  # `plants/{householdId}/{plantId}/...` (see backend image upload), so the
  # path pattern MUST be /plants/* — a /images/* pattern matches nothing and
  # silently falls through to the frontend-bucket default behavior. The
  # backend mints photo URLs as ${ASSETS_BASE_URL}/plants/... (env var wired
  # in modules/api), which lands here.
  ordered_cache_behavior {
    path_pattern           = "/plants/*"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "S3-images"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    cache_policy_id          = aws_cloudfront_cache_policy.images.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.cors_s3.id
  }

  # SPA fallback
  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  aliases = var.domain_name == "" ? [] : [var.domain_name, "www.${var.domain_name}"]

  viewer_certificate {
    cloudfront_default_certificate = var.domain_name == ""
    acm_certificate_arn            = var.domain_name == "" ? null : aws_acm_certificate_validation.frontend[0].certificate_arn
    ssl_support_method             = var.domain_name == "" ? null : "sni-only"
    # CloudFront's default cert only supports up to TLSv1 when you don't
    # specify, but we use real auth tokens in every environment (including
    # the no-domain dev one). Enforce TLSv1.2_2021 unconditionally — the
    # only browsers that can't negotiate it are EOL'd and shouldn't be
    # touching production-class credentials anyway.
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = {
    Name = "${var.project_name}-cdn-${var.environment}"
  }
}

# Custom domain wiring (only when var.domain_name is set).
# The hosted zone is auto-created by Route 53 when the domain is registered,
# so we read it via a data source rather than managing it here.
data "aws_route53_zone" "primary" {
  count        = var.domain_name == "" ? 0 : 1
  name         = var.domain_name
  private_zone = false
}

# CloudFront requires its ACM cert in us-east-1, regardless of distribution region.
resource "aws_acm_certificate" "frontend" {
  count                     = var.domain_name == "" ? 0 : 1
  provider                  = aws.us_east_1
  domain_name               = var.domain_name
  subject_alternative_names = ["www.${var.domain_name}"]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "${var.project_name}-cert-${var.environment}"
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = var.domain_name == "" ? {} : {
    for dvo in aws_acm_certificate.frontend[0].domain_validation_options :
    dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  }

  zone_id         = data.aws_route53_zone.primary[0].zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "frontend" {
  count                   = var.domain_name == "" ? 0 : 1
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.frontend[0].arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

resource "aws_route53_record" "apex" {
  count   = var.domain_name == "" ? 0 : 1
  zone_id = data.aws_route53_zone.primary[0].zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.frontend.domain_name
    zone_id                = aws_cloudfront_distribution.frontend.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "www" {
  count   = var.domain_name == "" ? 0 : 1
  zone_id = data.aws_route53_zone.primary[0].zone_id
  name    = "www.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.frontend.domain_name
    zone_id                = aws_cloudfront_distribution.frontend.hosted_zone_id
    evaluate_target_health = false
  }
}

# Cache Policies
resource "aws_cloudfront_cache_policy" "frontend" {
  name        = "${var.project_name}-frontend-${var.environment}"
  min_ttl     = 0
  default_ttl = 86400    # 1 day
  max_ttl     = 31536000 # 1 year

  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true
  }
}

resource "aws_cloudfront_cache_policy" "images" {
  name        = "${var.project_name}-images-${var.environment}"
  min_ttl     = 86400    # 1 day
  default_ttl = 604800   # 1 week
  max_ttl     = 31536000 # 1 year

  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true
  }
}

data "aws_cloudfront_origin_request_policy" "cors_s3" {
  name = "Managed-CORS-S3Origin"
}

# Security Headers
resource "aws_cloudfront_response_headers_policy" "security" {
  name = "${var.project_name}-security-headers-${var.environment}"

  security_headers_config {
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }
    # X-XSS-Protection is deprecated; modern advice (OWASP, Mozilla) is to
    # explicitly disable the legacy XSS-Auditor and rely on CSP for XSS
    # containment. Older browsers' auditors have themselves been XSS vectors.
    xss_protection {
      mode_block = false
      protection = false
      override   = true
    }
    content_security_policy {
      # Dropped `script-src 'unsafe-inline'` — Vite-built code emits hashed
      # ES modules, no inline scripts. Style still permits unsafe-inline
      # because Tailwind utility classes are emitted as inline styles by
      # some Heroicons SVG renders; revisit once those are migrated.
      #
      # script-src + connect-src + img-src include Google Tag Manager and
      # GA4 endpoints — required when VITE_GTM_ID is set at build time.
      # Removing GTM should also tighten these back to project hosts only.
      #
      # The broad `connect-src` AWS allowance is the existing trade for
      # AWS-SDK-in-browser calls (Cognito refresh, presigned-URL S3 PUTs).
      content_security_policy = "default-src 'self'; script-src 'self' https://www.googletagmanager.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://*.amazonaws.com https://*.amazoncognito.com https://www.googletagmanager.com https://www.google-analytics.com https://*.analytics.google.com https://*.g.doubleclick.net; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
      override                = true
    }
  }
}

# S3 Bucket Policy for CloudFront
resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCloudFrontServicePrincipal"
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.frontend.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.frontend.arn
          }
        }
      }
    ]
  })
}

resource "aws_s3_bucket_policy" "images" {
  bucket = aws_s3_bucket.images.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCloudFrontServicePrincipal"
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.images.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.frontend.arn
          }
        }
      }
    ]
  })
}
