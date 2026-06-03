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

variable "allowed_refs" {
  description = "Git refs the deploy role can be assumed from. Defaults to `main` branch + `v*` tags."
  type        = list(string)
  default     = ["ref:refs/heads/main", "ref:refs/tags/v*"]
}

variable "environment_name" {
  description = "GitHub environment name (defaults to 'production' for the strictest binding)."
  type        = string
  default     = "production"
}
