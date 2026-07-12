# Sprout integration

Family Greenhouse can route authenticated plant-care chat through the separate
Apache-2.0 [Sprout](https://github.com/ChelseaKR/sprout) service. This is a
first-party API integration, not a code or data merge.

## Privacy boundary

The backend sends only the user's question plus species, a coarse light category,
task type, and relative days due/completed. Before transmission it replaces known
plant nicknames with their species and redacts common email and phone patterns. It
never sends stored notes, photos, household/member IDs, member records, free-form
locations, coordinates, or exact task timestamps. Sprout rejects unknown payload
fields and labels corpus answers and household observations separately. As with
any free-text field, users should not put sensitive personal information in a chat question.

## Enablement

Store the same high-entropy HMAC secret in each deployment. For Family
Greenhouse, create a Secrets Manager value under the existing
`family-greenhouse/*` namespace and set:

```hcl
sprout_integration_enabled   = "1"
sprout_api_url               = "https://api.sprout.chelseakr.com"
sprout_integration_secret_id = "family-greenhouse/sprout-integration"
```

Set `SPROUT_FAMILY_GREENHOUSE_SECRET` to the secret value in the Sprout API
runtime. Signed requests expire after five minutes. The rollout is read-only;
task proposals and mutations remain in Family Greenhouse and require the
existing explicit confirmation flow.

If Sprout is unavailable during the initial rollout, the existing assistant is
used as a temporary fallback and a structured warning is emitted. Disable the
feature immediately by clearing `sprout_integration_enabled`.
