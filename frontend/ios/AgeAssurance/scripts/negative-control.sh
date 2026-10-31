#!/usr/bin/env bash
# Negative control for the AgeAssurance tests: prove they fail when a
# missing age signal is rendered as an adult.
#
# Copies the package to a temporary directory, rewrites the one line that
# reports an unrecognized range so it returns `.known(.adult, ...)` instead,
# checks that the rewrite actually applied (a sabotage that silently no-ops
# would read as a pass), then runs `swift test` and expects it to FAIL.
# Exit 0 means the control worked (the tests caught the sabotage).
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cp -R "$here/Package.swift" "$here/Sources" "$here/Tests" "$work/"
target="$work/Sources/AgeAssurance/AgeSignal.swift"
marker='// negative-control: unrecognized-range'

grep -q "$marker" "$target" || { echo "negative control: marker not found in AgeSignal.swift" >&2; exit 2; }

# Replace the line after the marker with the sabotaged mapping.
awk -v m="$marker" '
  skip { print "        return .known(.adult, declaration)"; skip = 0; next }
  index($0, m) { print; skip = 1; next }
  { print }
' "$target" > "$target.new"
mv "$target.new" "$target"

if diff -q "$here/Sources/AgeAssurance/AgeSignal.swift" "$target" >/dev/null; then
  echo "negative control: sabotage did not apply" >&2
  exit 2
fi
grep -q 'return .known(.adult, declaration)' "$target" || { echo "negative control: sabotaged line missing" >&2; exit 2; }

echo "negative control: sabotage applied (missing range -> adult); running swift test, expecting failure"
if (cd "$work" && swift test >"$work/test.log" 2>&1); then
  echo "negative control FAILED: tests passed with absence rendered as adult" >&2
  tail -20 "$work/test.log" >&2
  exit 1
fi
failures="$(grep -c 'error: -\[\|error: .*XCTAssert\|failed - ' "$work/test.log" || true)"
grep -q 'testNoBoundsIsUnavailableNotAdult' "$work/test.log" || {
  echo "negative control: swift test failed, but not on the expected test" >&2
  tail -40 "$work/test.log" >&2
  exit 1
}
echo "negative control OK: swift test failed as expected (${failures} failure lines, incl. testNoBoundsIsUnavailableNotAdult)"
