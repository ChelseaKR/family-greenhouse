# 0004 — No WAF on the HTTP API (it's unsupported)

**Status:** Accepted (2026-06)

## Context

A regional WAFv2 web ACL (rate-limit + AWS managed rule groups) had been provisioned with the intent of protecting the API. It was never actually associated — and an attempt to associate it failed in production: **WAFv2 cannot attach to an API Gateway _HTTP_ API (apigatewayv2)**. WAF supports REST API stages, ALB, CloudFront, AppSync, Cognito, and App Runner — not HTTP APIs. So the ACL cost ~$8–16/mo and protected nothing.

## Decision

Remove the regional WAF entirely (`modules/security` deleted). Edge/abuse defense rests on: API Gateway stage **throttling** (100 burst / 50 rate), **Cognito threat protection** (PLUS tier), and **in-code rate limiting** (per-IP on auth, per-user on writes).

## Consequences

- Saves ~$8–16/mo; removes a false sense of protection.
- **Trade-off: no managed-rule WAF at the edge** (e.g. generic SQLi/bad-input signatures). Low marginal value here — the API is a small JSON surface with parameterized DynamoDB (no SQL) and Zod validation.
- To reintroduce a real edge WAF, front the HTTP API with **CloudFront** and attach a **CLOUDFRONT-scoped** ACL there, or migrate to a REST API. Reconsider at scale or on a security-driven requirement.
