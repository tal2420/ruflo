#!/usr/bin/env bash
# pre-tool-policy-check.sh — SREFlow control plane enforcement.
#
# Stdin: Claude Code PreToolUse payload (JSON).
# Exit 0 -> allow. Exit non-zero -> deny.
#
# Fails closed on any error (missing opa, malformed input, policy error).
set -euo pipefail

PAYLOAD="$(cat)"

# Required binaries.
command -v jq  >/dev/null 2>&1 || { echo "sreflow: jq missing" >&2; exit 97; }
command -v opa >/dev/null 2>&1 || { echo "sreflow: opa missing — failing closed" >&2; exit 98; }

TOOL_NAME="$(jq -r '.tool_name // empty' <<<"$PAYLOAD")"
TOOL_INPUT="$(jq  '.tool_input  // {}'    <<<"$PAYLOAD")"

# Agent context is injected by the SREFlow runtime into env vars at spawn time.
AGENT_ROLE="${SREFLOW_AGENT_ROLE:-unknown}"
AGENT_ENV="${SREFLOW_AGENT_ENV:-unknown}"
TARGET_ENV="${SREFLOW_TARGET_ENV:-$AGENT_ENV}"
BP_TIER="${SREFLOW_TARGET_TIER:-1}"  # Default to tier-1 = most protective.
CANONICAL_ID="${SREFLOW_TARGET_CANONICAL_ID:-}"
APPROVALS_JSON="${SREFLOW_APPROVALS_JSON:-[]}"

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Compose OPA input.
OPA_INPUT="$(jq -nc \
  --arg role "$AGENT_ROLE" \
  --arg aenv "$AGENT_ENV" \
  --arg tenv "$TARGET_ENV" \
  --argjson tier "$BP_TIER" \
  --arg cid "$CANONICAL_ID" \
  --arg tool "$TOOL_NAME" \
  --argjson tinput "$TOOL_INPUT" \
  --argjson approvals "$APPROVALS_JSON" \
  --arg now "$NOW" \
  '{
     agent:     { role: $role, env: $aenv },
     tool:      $tool,
     tool_input: $tinput,
     target:    { env: $tenv, canonicalEntityId: $cid, businessProcessTier: $tier },
     approvals: $approvals,
     now:       $now
   }')"

# Evaluate all four policy packages.
ALLOW_BR=$(opa eval  -d sre/policies/ --stdin-input -I "data.sreflow.blast_radius.allow"        <<<"$OPA_INPUT" | jq -r '.result[0].expressions[0].value // false')
ALLOW_ENV=$(opa eval -d sre/policies/ --stdin-input -I "data.sreflow.environment_isolation.allow" <<<"$OPA_INPUT" | jq -r '.result[0].expressions[0].value // false')
ALLOW_FZ=$(opa eval  -d sre/policies/ --stdin-input -I "data.sreflow.freeze_windows.allow"        <<<"$OPA_INPUT" | jq -r '.result[0].expressions[0].value // false')

if [[ "$ALLOW_BR" == "true" && "$ALLOW_ENV" == "true" && "$ALLOW_FZ" == "true" ]]; then
  exit 0
fi

# Compose a structured denial reason.
REASON_BR=$(opa eval  -d sre/policies/ --stdin-input -I "data.sreflow.blast_radius.deny_reason"        <<<"$OPA_INPUT" | jq -r '.result[0].expressions[0].value // "n/a"')
REASON_ENV=$(opa eval -d sre/policies/ --stdin-input -I "data.sreflow.environment_isolation.deny_reason" <<<"$OPA_INPUT" | jq -r '.result[0].expressions[0].value // "n/a"')

AUDIT_LINE=$(jq -nc \
  --arg t "$NOW" \
  --arg tool "$TOOL_NAME" \
  --arg role "$AGENT_ROLE" \
  --arg br "$REASON_BR" \
  --arg env "$REASON_ENV" \
  --argjson fz "$ALLOW_FZ" \
  '{ at: $t, decision: "deny", tool: $tool, role: $role, reasons: { blast_radius: $br, environment: $env, freeze_open: $fz } }')

# Best-effort audit write. Hook script never throws beyond its exit code.
echo "$AUDIT_LINE" >> "${SREFLOW_AUDIT_LOG:-/var/log/sreflow/denials.jsonl}" || true

echo "sreflow-policy: DENIED tool=$TOOL_NAME reasons=$AUDIT_LINE" >&2
exit 1
