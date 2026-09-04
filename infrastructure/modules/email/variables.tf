variable "environment" {
  description = "Environment name"
  type        = string
}

variable "project_name" {
  description = "Project name"
  type        = string
}

variable "domain_name" {
  description = "Domain (apex) for the SES identity, e.g. familygreenhouse.net"
  type        = string
}

variable "dmarc_rua_email" {
  description = "Mailbox for aggregate DMARC reports. Defaults to dmarc@<domain>."
  type        = string
  default     = ""
}

variable "mail_from_subdomain" {
  description = "Label for the custom MAIL FROM subdomain, e.g. \"mail\" for mail.familygreenhouse.net. Must not collide with an existing record name in the zone."
  type        = string
  default     = "mail"

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?$", var.mail_from_subdomain))
    error_message = "mail_from_subdomain must be a single lowercase DNS label (letters, digits, hyphens)."
  }
}
