#!/usr/bin/env bash
# publish-gate.sh — scan a tree for things that must never be published: keys and
# tokens, private keys, credential files, committed .env files, tailnet addresses
# and personal contact details. Run it before every push; CI runs it on every change.
#
#   scripts/publish-gate.sh [repo_dir]    exit 0 = clean, 1 = blocked
#   scripts/publish-gate.sh --self-test   prove every rule still fires
#
# Your own private markers (an employer, a hostname, a home path) belong in a file
# OUTSIDE the repo, one extended regex per line (# comments and blank lines ignored),
# named by GATE_PRIVATE_PATTERNS:
#
#   GATE_PRIVATE_PATTERNS=~/.config/publish-gate/patterns.txt scripts/publish-gate.sh
#
# Hits are reported as file:line only, never the matched text, so the gate's own
# output (a CI log, say) cannot republish what it found.
#
# app/scripts/check-web-bundle.mjs reruns the `scan`/`scan_cs` rules below over the
# web build, so each rule stays on one line with a single-quoted pattern that both
# `grep -E` and JavaScript can read.
set -uo pipefail

_SELF=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")

# --- self-test ---------------------------------------------------------------
# Plants one probe per rule in a throwaway tree and asserts each rule fires, and
# that a clean tree passes. A rule that never fires silently stops protecting.
# The probes are assembled at runtime, so this file holds no literal secret shape.
if [ "${1:-}" = "--self-test" ]; then
  _probe=$(mktemp -d) && _clean=$(mktemp -d) && _pp=$(mktemp) || exit 1
  trap 'rm -rf "$_probe" "$_clean" "$_pp"' EXIT
  {
    printf 'sk-ant-%s\n' 'aaaaaaaaaaaaaaaaaaaaaaaa'
    printf '%s\n' '-----BEGIN OPENSSH PRIVATE KEY-----'
    printf 'AIza%s\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    printf '"ascAppId": "%s"\n' '123456789'
    printf 'http://%s.%s.ts.net/\n' 'laptop' 'tail0a1b2c'
    printf '%s.%s.%s.%s\n' 100 101 102 103
    printf '(%s) %s-%s\n' 555 555 0123
    printf '%s Main Street\n' 123
    printf 'someone@%s.com\n' 'gmail'
    printf '%s\n' 'zz-private-probe-marker'
  } > "$_probe/probe.txt"
  printf 'REPLACE=1\n' > "$_probe/.env"
  : > "$_probe/AuthKey_TEST.p8"
  printf '# a comment, then a pattern\n\nzz-private-probe-\n' > "$_pp"
  printf 'clean tree, nothing to report\n' > "$_clean/ok.txt"
  _labels=(
    "secrets: tokens/keys" "secrets: PEM private key" "secrets: slack/google"
    "ident: ASC/EAS account ids" "host: tailnet address" "pii: phone number"
    "pii: street address" "pii: personal email" "secrets: committed .env file"
    "secrets: credential files" "private: GATE_PRIVATE_PATTERNS"
  )
  _out=$(GATE_PRIVATE_PATTERNS="$_pp" bash "$_SELF" "$_probe" 2>&1); _rc=$?; _bad=0
  [ "$_rc" -eq 1 ] || { echo "self-test: dirty tree did not block (exit $_rc)"; _bad=1; }
  for _l in "${_labels[@]}"; do
    if ! printf '%s\n' "$_out" | grep -qF "FAIL  [$_l]"; then
      echo "self-test: rule did not fire: $_l"; _bad=1
    fi
  done
  if printf '%s\n' "$_out" | grep -qF 'zz-private-probe-marker'; then
    echo "self-test: the gate printed a matched value"; _bad=1
  fi
  GATE_PRIVATE_PATTERNS="$_pp" bash "$_SELF" "$_clean" >/dev/null 2>&1 \
    || { echo "self-test: clean tree was blocked"; _bad=1; }
  _out=$(GATE_PRIVATE_PATTERNS='' bash "$_SELF" "$_clean" 2>&1) \
    || { echo "self-test: clean tree was blocked without private patterns"; _bad=1; }
  printf '%s\n' "$_out" | grep -qF "skip  [private: GATE_PRIVATE_PATTERNS]" \
    || { echo "self-test: an unset GATE_PRIVATE_PATTERNS was not reported as skipped"; _bad=1; }
  if GATE_PRIVATE_PATTERNS="$_probe/no-such-file" bash "$_SELF" "$_clean" >/dev/null 2>&1; then
    echo "self-test: an unreadable GATE_PRIVATE_PATTERNS file passed"; _bad=1
  fi
  if [ "$_bad" -eq 0 ]; then echo "GATE SELF-TEST: PASS (${#_labels[@]} rules fire)"; exit 0
  else echo "GATE SELF-TEST: FAIL"; exit 1; fi
fi

REPO="${1:-.}"
cd "$REPO" || { echo "no such dir: $REPO"; exit 1; }

EXCLUDES=(--exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist
          --exclude-dir=.venv --exclude-dir=.pytest_cache --exclude-dir=__pycache__
          --exclude-dir=.build --exclude-dir=.expo
          --exclude=publish-gate.sh)   # the gate quotes these patterns itself
fails=0

_report() { # label, hits (file:line per line)
  local label="$1" out="$2"
  if [ -n "$out" ]; then
    local n; n=$(printf '%s\n' "$out" | wc -l | tr -d ' ')
    echo "FAIL  [$label] $n hit(s):"
    printf '%s\n' "$out" | head -10 | sed 's/^/        /'
    fails=$((fails+1))
  else
    echo "ok    [$label]"
  fi
}

# file:line only — the matched text is never echoed.
_where() { cut -d: -f1-2; }

# Case-INsensitive scan (prose-style terms: hosts, addresses).
scan() { # label, pattern
  local out; out=$(grep -rIniE "$2" "${EXCLUDES[@]}" . 2>/dev/null | _where)
  _report "$1" "$out"
}

# Case-SENSITIVE scan. Token shapes are case-significant: with -i, classes like
# [0-9A-Z] widen to all alphanumerics and random base64 starts to match.
scan_cs() { # label, pattern
  local out; out=$(grep -rInE "$2" "${EXCLUDES[@]}" . 2>/dev/null | _where)
  _report "$1" "$out"
}

echo "== publish gate =="
scan_cs "secrets: tokens/keys"      'sk-ant-[A-Za-z0-9_-]{20}|sk-proj-[A-Za-z0-9_-]{20}|sk-or-v1-[0-9a-f]{32}|gh[pousr]_[A-Za-z0-9]{30}|github_pat_[A-Za-z0-9_]{20}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10}|glpat-[A-Za-z0-9_-]{20}|[sr]k_live_[0-9A-Za-z]{20}|\b[0-9]{8,10}:AA[0-9A-Za-z_-]{33}\b'
# A PEM header must start its own line (otherwise random base64 matches).
scan_cs "secrets: PEM private key"  '^-----BEGIN [A-Z ]*PRIVATE KEY-----$'
scan_cs "secrets: slack/google"     'xapp-[0-9A-Za-z-]{10}|AIza[0-9A-Za-z_-]{35}'
# App Store Connect submission credentials must be placeholders. An EAS projectId is
# not covered: it ships inside every built app, so it is public by construction.
scan_cs "ident: ASC/EAS account ids" '"(ascAppId|ascApiKeyId|ascApiKeyIssuerId)": *"[0-9a-zA-Z][0-9a-zA-Z-]{5,}"'
# A real tailnet: an address in the carrier-grade NAT block Tailscale assigns from,
# or a MagicDNS name (machine.tailnet.ts.net). Placeholders such as
# <machine>.<tailnet>.ts.net pass.
# RFC 1918 LAN addresses are not flagged: 192.168.1.50 in a doc identifies no one.
scan    "host: tailnet address"     '\b100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}\b|[a-z0-9-]+\.[a-z0-9-]+\.ts\.net'
# Personal contact details. The owner's name is fine; their phone, address and
# personal email are not.
scan    "pii: phone number"   '\b(\+1[ .-]?)?\(?[2-9][0-9]{2}\)?[ .-][0-9]{3}[ .-][0-9]{4}\b'
scan    "pii: street address" '\b[0-9]{1,5} [A-Z][A-Za-z]+ (Street|Avenue|Ave|Road|Drive|Lane|Boulevard|Blvd)\b'
scan    "pii: personal email" '[A-Za-z0-9._%+-]+@(gmail|icloud|outlook|yahoo|hotmail|proton|protonmail)\.[A-Za-z]{2,}'

# .env files must never ship; only the *.example / *.sample / *.template forms may.
scan_env() {
  local out; out=$(find . \( -path ./.git -o -name node_modules -o -name .venv \) -prune -o \
    -type f \( -name '.env' -o -name '.env.*' \) \
    ! -name '*.example' ! -name '*.sample' ! -name '*.template' -print 2>/dev/null)
  _report "secrets: committed .env file" "$out"
}
scan_env

# Key and certificate files, by name.
scan_files() {
  local out; out=$(find . \( -path ./.git -o -name node_modules -o -name .venv \) -prune -o \
    -type f \( -iname '*.p8' -o -iname '*.p12' -o -iname '*.pfx' -o -iname '*.pem' -o -iname '*.key' \
       -o -iname '*.keystore' -o -iname '*.jks' -o -iname '*.mobileprovision' \
       -o -name 'id_rsa' -o -name 'id_ecdsa' -o -name 'id_ed25519' -o -name 'id_dsa' \) -print 2>/dev/null)
  _report "secrets: credential files" "$out"
}
scan_files

# Owner-private markers, from a file that is never committed.
scan_private() {
  local label="private: GATE_PRIVATE_PATTERNS" file="${GATE_PRIVATE_PATTERNS:-}" pats out
  if [ -z "$file" ]; then
    echo "skip  [$label] (not set — your own markers are not checked)"
    return
  fi
  if [ ! -r "$file" ]; then
    echo "FAIL  [$label] the file it names cannot be read"
    fails=$((fails+1))
    return
  fi
  pats=$(mktemp) || { fails=$((fails+1)); return; }
  grep -vE '^[[:space:]]*(#|$)' "$file" > "$pats"
  if [ -s "$pats" ]; then
    out=$(grep -rIniE -f "$pats" "${EXCLUDES[@]}" . 2>/dev/null | _where)
  else
    out=""
  fi
  rm -f "$pats"
  _report "$label" "$out"
}
scan_private

echo
if [ "$fails" -eq 0 ]; then echo "GATE: PASS — safe to publish"; exit 0
else echo "GATE: BLOCKED — $fails categor(y|ies) with hits"; exit 1; fi
