variable "project_name" {
  description = "Project name (used in resource names)"
  type        = string
}

variable "github_org" {
  description = "GitHub organization or user that owns the repo (e.g. 'ChelseaKR')"
  type        = string
}

variable "github_repo" {
  description = "GitHub repo name (e.g. 'family-greenhouse')"
  type        = string
}

variable "deploy_environments" {
  description = "GitHub environments whose jobs may assume the deploy role (terraform apply, IAM writes). Each must have a required reviewer: the trust policy cannot check that, and an environment with none is an unapproved way to this role."
  type        = list(string)
  default     = ["production"]

  validation {
    condition     = length(var.deploy_environments) > 0 && alltrue([for name in var.deploy_environments : can(regex("^[A-Za-z0-9_-]+$", name))])
    error_message = "deploy_environments must name at least one GitHub environment, with no wildcard."
  }
}

variable "release_environments" {
  description = "GitHub environments whose jobs may assume the release role (no IAM writes): the production jobs after the approved Terraform job, and the staging jobs. These carry no reviewer, so a release pauses once."
  type        = list(string)
  default     = ["production-release", "staging"]

  validation {
    condition     = alltrue([for name in var.release_environments : can(regex("^[A-Za-z0-9_-]+$", name))])
    error_message = "release_environments must be plain GitHub environment names, with no wildcard."
  }
}

variable "alert_relay_environments" {
  description = "GitHub environments whose jobs may assume the read-only alert-relay role."
  type        = list(string)
  default     = ["alert-relay"]

  validation {
    condition     = alltrue([for name in var.alert_relay_environments : can(regex("^[A-Za-z0-9_-]+$", name))])
    error_message = "alert_relay_environments must be plain GitHub environment names, with no wildcard."
  }
}

variable "legacy_allowed_refs" {
  description = "Git refs the deploy role may ALSO be assumed from. Empty, and meant to stay empty: it exists for the one-time move to environment-only trust, when the workflows on main still assume the role from a branch or a tag. See docs/cicd-setup.md."
  type        = list(string)
  default     = []
}
