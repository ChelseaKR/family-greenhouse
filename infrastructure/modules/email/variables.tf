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
