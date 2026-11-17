# 0046 — An uploaded photo is checked and stored apart from the upload

**Status:** Accepted

**Date:** 2026-11-17

**Deciders:** Chelsea Kelly-Reif

**Related:** [ADR 0033](0033-plant-photos-are-served-only-through-short-lived-signed-urls.md) (photos are
served only through short-lived signed URLs), [ADR 0020](0020-token-scoped-caretaker-seats.md)
(caretaker seats, the second uploader).

## Context

A plant photo reaches storage in two steps. The app asks the API for an upload URL, sends the file
straight to S3, then asks the API to confirm it. The confirm step checks the object's size and type,
removes its metadata, and attaches it to the plant.

Three things about that were weaker than the rule they served (5 MiB, a real image, no metadata):

- The upload URL said which key to write and nothing about how much. The size was checked after the
  bytes were already stored.
- The object that was checked was the object the upload URL could still write to, for the rest of
  the URL's five minutes.
- An upload that was never confirmed stayed in the bucket. No row pointed at it and nothing removed
  it.

Members and caretaker seats use the same two steps, so both had the same shape.

## Decision

1. **The upload URL is signed for one file.** `POST /plants/{id}/image` and the caretaker route take
   `contentLength`, the file's exact size in bytes, and refuse a request without it or above 5 MiB.
   The presigned PUT signs `Content-Type` and `Content-Length`, so storage itself refuses a request
   that sends another type or another size. The URL is still valid for five minutes.
2. **An upload lands in a holding prefix.** The key is `uploads/{householdId}/{plantId}/{uuid}.{ext}`.
   No upload URL is ever signed for a key under `plants/`, and no response ever signs a read for a
   key under `uploads/`.
3. **The confirm step stores its own copy.** It reads the holding object, checks size, declared type
   and actual bytes, removes the metadata, and writes the result to a new key
   `plants/{householdId}/{plantId}/{uuid}.{ext}` with a write that succeeds only if the key does not
   exist. That object is the plant's photo. The confirm response returns its reference; the reference
   the client sent only names the upload. The holding object is then deleted, every version of it.
4. **The bucket removes what was never confirmed.** A lifecycle rule on `uploads/` expires current
   objects after one day and the versions behind them one day later. S3 removes the delete markers
   that leaves on its own.
5. **One implementation for both uploaders.** `services/photoIntake.ts` holds the presign and the
   confirm; the member and caretaker handlers call it.

A presigned POST with a `content-length-range` condition was the other way to bound the size. It
would have changed the upload from a PUT to a multipart form in every client, the mock server and
the bucket's CORS rule. Signing the exact length of a PUT gives the same bound with one new request
field.

## Consequences

- **A client that does not send `contentLength` cannot add a photo.** That is every build before this
  change. The website picks up the new code on its next load; a tab or installed web app still
  running the old code gets a 400 that says to reload or update. A store build of the iPhone or
  Android app made before this change would lose photo upload, so this ships before the first store
  build is cut.
- A photo's stored reference is no longer the reference the presign returned. Clients that showed
  the photo from the confirm response or from a refetch are unaffected; the two shipped clients do
  one or the other.
- After a confirm, the upload URL can still write to its holding key until it expires, for exactly
  the declared type and size. Nothing reads that object unless it is confirmed again, which checks
  it again, and the lifecycle rule removes it.
- Each confirmed photo costs one more S3 write and one delete. Bytes are held in the function's
  memory once, as before.
- If the photo row cannot be written after the copy is stored, the copy is deleted, best effort.
- The post-deploy smoke test uploads through real S3 and now also expects S3 to refuse a PUT of a
  different size. If S3 ever accepted it, the release would fail its smoke test and roll back.
- Not changed: the sitter's photo-back route, which already receives the bytes in the request body
  and stores only what it has cleaned.
