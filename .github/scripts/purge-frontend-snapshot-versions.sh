#!/usr/bin/env bash

# Permanently remove one completed production frontend rollback snapshot from a
# versioned S3 bucket. Deleting only the current objects would leave every old
# version and delete marker billable, so this drains ListObjectVersions in
# batches until the exact run-scoped prefix is empty.

set -euo pipefail

artifact_bucket=${1:-}
snapshot_prefix=${2:-}

if [[ ! $artifact_bucket =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]]; then
  echo "Invalid artifact bucket: ${artifact_bucket:-<empty>}" >&2
  exit 1
fi

# This guard is intentionally narrower than a generic S3 prefix check. It makes
# an empty, root-level, or caller-controlled broad purge impossible even if a
# future workflow accidentally passes the wrong value.
if [[ ! $snapshot_prefix =~ ^frontend-snapshots/[0-9]+$ ]]; then
  echo "Refusing to purge invalid frontend snapshot prefix: ${snapshot_prefix:-<empty>}" >&2
  exit 1
fi

exact_prefix="${snapshot_prefix}/"
deleted_count=0

while true; do
  page_json=$(aws s3api list-object-versions \
    --bucket "$artifact_bucket" \
    --prefix "$exact_prefix" \
    --max-keys 1000 \
    --no-paginate \
    --output json)

  delete_json=$(jq -c \
    '{Objects: (((.Versions // []) + (.DeleteMarkers // [])) | map({Key, VersionId}) | .[:1000]), Quiet: true}' \
    <<< "$page_json")
  batch_count=$(jq -r '.Objects | length' <<< "$delete_json")

  if ((batch_count == 0)); then
    break
  fi

  result_json=$(aws s3api delete-objects \
    --bucket "$artifact_bucket" \
    --delete "$delete_json" \
    --output json)
  error_count=$(jq -r '(.Errors // []) | length' <<< "$result_json")

  if ((error_count > 0)); then
    echo "S3 reported errors while purging ${exact_prefix}:" >&2
    jq -r '.Errors[] | "  \(.Key) version \(.VersionId): \(.Code) \(.Message)"' \
      <<< "$result_json" >&2
    exit 1
  fi

  deleted_count=$((deleted_count + batch_count))
done

echo "Purged ${deleted_count} object version(s) and delete marker(s) from s3://${artifact_bucket}/${exact_prefix}"
