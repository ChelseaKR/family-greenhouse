# 0002 — Serverless on AWS, single region

**Status:** Accepted

## Context
A solo-built household app with unpredictable, low early traffic needs to cost ~nothing at zero usage and scale without ops. Options weighed: containers (ECS/Fargate, always-on cost), a PaaS (Render/Fly, simpler but less control + own lock-in), or serverless on AWS.

## Decision
Serverless on AWS, single region (us-east-1): API Gateway HTTP API → Lambda (one per handler group) → DynamoDB, with Cognito, S3, SES/SNS, CloudFront, EventBridge. Everything in Terraform.

## Consequences
- **Scales to zero** — the running app costs ~$2–3/mo; no idle compute.
- **Operationally light** — no servers to patch; AWS-managed everything.
- **Trade-off: AWS lock-in.** Every layer is AWS; migrating off is months of work. Accepted as the right call for cost/ops at this stage — revisit only if a customer needs multi-cloud.
- **Trade-off: single region.** A regional outage takes the app down. Multi-region (Global Tables + failover) is deliberately deferred — see `docs/deferred-resilience.md`; trigger is a B2B SLA or material non-US user base. DR is covered by PITR (drilled — `docs/runbooks.md`).
- Cold starts exist but are acceptable at this scale (chat Lambda sized higher for the Bedrock loop).
