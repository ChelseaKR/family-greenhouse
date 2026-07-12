variable "environment" {
  description = "Environment name"
  type        = string
}

variable "project_name" {
  description = "Project name"
  type        = string
}

variable "domain_name" {
  description = "Domain name (optional)"
  type        = string
  default     = ""
}

variable "hosted_zone_name" {
  description = "Route 53 hosted zone containing domain_name"
  type        = string
  default     = ""
}

variable "include_www_alias" {
  description = "Whether to provision www.<domain_name> as a second alias"
  type        = bool
  default     = true
}
