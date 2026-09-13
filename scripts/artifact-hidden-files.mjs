/**
 * Does a workflow's `frontend/dist` artifact upload carry hidden files?
 *
 * `.well-known/` is a hidden directory, and `actions/upload-artifact` drops
 * hidden files unless `include-hidden-files: true` is set. A workflow that
 * builds an association file into `dist/` and then hands `dist/` to a deploy
 * job through an artifact loses it in transit, and every step stays green: the
 * build succeeds, the artifact uploads, and the deploy's `if [ -f ... ]` guard
 * simply finds nothing to copy. Nothing reports the loss.
 *
 * That is how v0.33.0 deployed successfully on 2026-09-13 while
 * https://familygreenhouse.net/.well-known/apple-app-site-association answered
 * 404 — the Deploy Frontend job uploaded 331 objects, none under
 * `.well-known/`, and the build job's log recorded `include-hidden-files:
 * false`.
 *
 * Lives in its own module so it can be unit-tested: `check-well-known.mjs`
 * runs its gate at import time and cannot be imported from a test.
 */

/** What the upload step must carry. */
export const INCLUDE_HIDDEN = 'include-hidden-files: true';

/** The artifact path whose contents reach the deploy job. */
const DIST_PATH = /^\s*path:\s*frontend\/dist\s*$/u;

/**
 * The `with:` blocks of every `actions/upload-artifact` step in `text` whose
 * `path:` is `frontend/dist`. Returned as raw text so the caller can look for
 * whatever it needs; an empty array means no such step exists.
 */
export function distArtifactUploads(text) {
  const lines = text.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!DIST_PATH.test(lines[i])) continue;
    // Walk back to this step's `uses:` — a `path: frontend/dist` under some
    // other action (a cache, say) is not an artifact upload and is not ours.
    let isUpload = false;
    for (let j = i; j >= 0 && j > i - 12; j -= 1) {
      if (/uses:.*upload-artifact/u.test(lines[j])) {
        isUpload = true;
        break;
      }
      // A new list item before any `uses:` means we left the step.
      if (j !== i && /^\s*-\s/u.test(lines[j])) break;
    }
    if (!isUpload) continue;
    let block = '';
    for (let j = i + 1; j < lines.length && !/^\s*-\s/u.test(lines[j]); j += 1)
      block += `${lines[j]}\n`;
    blocks.push(block);
  }
  return blocks;
}

/**
 * Problems with `file`'s dist-artifact uploads, as sentences. `dist` is what
 * the deploy job calls the directory, only so the message can name the guard
 * that silently finds nothing.
 */
export function artifactHiddenFileProblems(file, text, dist) {
  const uploads = distArtifactUploads(text);
  if (uploads.length === 0) {
    return [
      `${file}: no \`actions/upload-artifact\` step with \`path: frontend/dist\` found. ` +
        `This gate asserts such a step carries \`${INCLUDE_HIDDEN}\`; if this path no longer ` +
        `hands dist/ to the deploy job through an artifact, set viaArtifact:false for it in ` +
        `scripts/check-well-known.mjs in the same change.`,
    ];
  }
  return uploads
    .filter((block) => !block.includes(INCLUDE_HIDDEN))
    .map(
      () =>
        `${file}: the \`frontend/dist\` artifact upload does not set \`${INCLUDE_HIDDEN}\`. ` +
        `\`.well-known/\` is a hidden directory, so the association files are built into ` +
        `dist/, silently dropped from the artifact, and the deploy job's ` +
        `\`if [ -f ${dist}/.well-known/... ]\` guard finds nothing — a green deploy that ` +
        `publishes no association file and leaves the URL answering 404.`
    );
}
