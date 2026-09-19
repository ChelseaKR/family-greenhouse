# 0033 — Plant photos are served only through short-lived signed URLs

**Status:** Accepted

**Date:** 2026-09-18

**Deciders:** Chelsea Kelly-Reif

**Related:** [#453](https://github.com/ChelseaKR/family-greenhouse/issues/453) (a sitter brief's
photo expires with the link); [ADR 0015](0015-the-away-kit.md); [ADR 0021](0021-email-rendering-and-usefulness.md)
(email loads no remote images); [ADR 0030](0030-household-trash-moves-rows-out-of-the-live-key-space.md);
`backend/src/services/photoAccess.ts`, `backend/src/middleware/photoUrls.ts`,
`infrastructure/modules/frontend/main.tf`.

## Context

Plant photos live in a private S3 bucket, keyed `plants/{householdId}/{plantId}/{uuid}.{ext}`.
The URL stored on a plant row is `${ASSETS_BASE_URL}/<key>`. #453 made the sitter brief hand out
a signed URL that expires with the link, but a photo's lifetime has to be a property of how photos
are served, not of one page that serves them. Photos of plants are photos of the inside of
people's homes, and v0.37.0's native camera will make many more of them.

## Decision

1. **Nothing but a signed URL reads a photo.** The CloudFront distribution has no origin for the
   images bucket, and the bucket's policy allows nothing to anyone (it only denies plain HTTP). With
   every public access block on, the readers are the API's own role and whoever holds a presigned
   GET that role minted. S3 itself refuses a request with no signature, or with an expired one.
2. **S3 presigned GETs, not CloudFront signed URLs.** The presigner is already in production for
   the sitter brief. CloudFront signing would need a key pair: a private key to generate, store,
   hand to every Lambda and rotate. It would also have to keep `/plants/{plantId}` (an app route
   under the same prefix as the photos) working through the distribution's error pages. With no
   images behavior at all, that route is resolved by `spa-router.js` like every other app route.
3. **The stored URL is a reference.** It names the object and serves nothing. It stays in the rows
   (and in `ASSETS_BASE_URL`) because the upload confirm step matches against it and existing rows
   carry it. Existing photos need no migration: the key is read from the reference's path, whatever
   origin it was minted under.
4. **Signing happens at the response, in one place.** `createHandler` puts `photoUrlSigner` on
   every route. It replaces each reference under an `imageUrl` or `photoUrl` field with a
   presigned GET, and never touches any other field. A key is signed only for a household the
   request is entitled to: the caller's active household, or the households a route declares
   with `scopePhotoUrls` (a public link's household; every home, for cross-home Today). Two
   routes opt out because their `imageUrl` is the reference by design: the upload presign
   (the client sends it back to confirm) and the data export (which names photos without
   carrying them). A surface that is missed fails closed: its photo does not load.
5. **Lifetimes.**
   - Household app: at least an hour. The same URL is reused for up to 30 minutes, so the browser's
     cache answers repeat views, and a page asks for fresh URLs when a photo fails to load.
   - Public links: the URL never outlives the link. A shared cutting is capped at the share's own
     expiry. A sitter brief signs afresh on every request, for at most an hour, never past the link.
     A link in its last second gets no photo rather than one that outlasts it.
   - Every response is told to cache the photo privately, for no longer than an hour.
6. **Email carries no photos.** An email is opened days later, forwarded and archived, and no photo
   URL can stay short-lived there. Digest rows are text and a link to the plant. This narrows
   ADR 0021's one exception to its no-remote-images rule to nothing.

## Consequences

- A photo is no longer cached at the edge. Each first view is an S3 GET; repeat views inside a
  reuse window come from the browser. The service worker's image cache does not match signed URLs,
  so photos are not kept for offline use.
- A URL signed with the Lambda's temporary credentials can die before its stated expiry, when the
  role session ends. The page's refresh-on-failure covers it.
- Revoking a link stops new URLs at once. A URL minted before the revoke works until it expires,
  at most about an hour and a half later, and never past the link's own end.
- **Deploy order.** A release applies Terraform before it deploys the backend. Between the two, the
  images origin is gone and the running backend still returns references, so photos in the app do
  not load for those minutes. The release's own `/*` invalidation clears the edge's copies. Rolling
  back the backend alone leaves photos unloadable until the next deploy: it fails closed.
