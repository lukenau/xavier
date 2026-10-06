#!/usr/bin/env bash
# check-dco.sh — enforce the Developer Certificate of Origin (DCO) on commits.
#
# Every commit must carry a `Signed-off-by:` trailer (git commit -s).
#
# Range selection:
#   * On a GitHub pull_request run: all non-merge commits in
#     BASE..HEAD, where BASE comes from the PR base SHA
#     (github.event.pull_request.base.sha, passed as PR_BASE_SHA by the
#     workflow) or, failing that, the PR base branch ref GitHub provides
#     in GITHUB_BASE_REF.
#   * Fallback (local use): only the last commit (HEAD).
#
# If the commit range is empty — push to main, or a shallow checkout where
# the base commit is not available locally — the check skips cleanly (exit 0).
#
# Exit 0 = all inspected commits signed off (or nothing to inspect).
# Exit 1 = at least one inspected commit lacks a sign-off.
# Exit 2 = git failure while inspecting.
set -uo pipefail

fail=0
pass=0

check_commit() { # sha
  local sha="$1" subject body
  subject=$(git show -s --format=%s "$sha" 2>/dev/null) || return 2
  body=$(git show -s --format=%B "$sha" 2>/dev/null) || return 2
  if printf '%s\n' "$body" | grep -qiE '^Signed-off-by: .+'; then
    pass=$((pass + 1))
  else
    printf 'FAIL  %s  %s\n' "${sha:0:12}" "$subject"
    fail=$((fail + 1))
  fi
}

# --- determine what to inspect -------------------------------------------
commits=""
mode=""

if [ "${GITHUB_EVENT_NAME:-}" = "pull_request" ] && [ -n "${GITHUB_BASE_REF:-}" ]; then
  base=""
  if [ -n "${PR_BASE_SHA:-}" ] && git cat-file -e "${PR_BASE_SHA}^{commit}" 2>/dev/null; then
    base="$PR_BASE_SHA"
  elif git rev-parse -q --verify "refs/remotes/origin/${GITHUB_BASE_REF}" >/dev/null 2>&1; then
    base="origin/${GITHUB_BASE_REF}"
  fi
  if [ -n "$base" ]; then
    mode="pull_request ($base..HEAD)"
    commits=$(git rev-list --no-merges "$base..HEAD" 2>/dev/null)
  else
    # Shallow checkout: the base commit is not present locally. Skip rather
    # than fail; a fetch-depth: 0 checkout in the workflow avoids this.
    echo "DCO: shallow checkout, PR base not available locally — skipping"
    exit 0
  fi
else
  mode="local fallback (HEAD)"
  commits=$(git rev-parse -q --verify HEAD) || { echo "DCO: no commits found — skipping"; exit 0; }
fi

if [ -z "$commits" ]; then
  echo "DCO: no commits in range ($mode) — nothing to check, skipping"
  exit 0
fi

echo "DCO: checking $mode"

# shellcheck disable=SC2086  # intentionally unquoted: word-split commit list
for sha in $commits; do
  check_commit "$sha" || { echo "DCO: git error inspecting $sha" >&2; exit 2; }
done

if [ "$fail" -gt 0 ]; then
  echo
  echo "DCO check FAILED: $fail of $((fail + pass)) commit(s) missing 'Signed-off-by:' trailer."
  echo "Every commit must include a Developer Certificate of Origin sign-off."
  echo "Fix it by re-signing the offending commit(s) and force-pushing:"
  echo "  latest commit only: git commit -s --amend --no-edit"
  echo "  older commits:       git rebase -i <base>   # mark them 'edit',"
  echo "                       then: git commit -s --amend --no-edit && git rebase --continue"
  exit 1
fi

echo "DCO OK: $pass commit(s) signed off"
exit 0
