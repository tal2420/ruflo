#!/usr/bin/env bash
# post-tool-audit.sh — appends an immutable record of every tool call.
#
# The sink is a WORM-backed log (S3 Object Lock, or an append-only Kafka topic
# fronted by an SSE endpoint). For local development, writes to a JSONL file.
set -euo pipefail

PAYLOAD="$(cat || true)"
NOW="$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)"

if [[ "${1:-}" == "--session-end" ]]; then
  RECORD=$(jq -nc \
    --arg at "$NOW" \
    --arg role "${SREFLOW_AGENT_ROLE:-unknown}" \
    --arg sess "${SREFLOW_SESSION_ID:-unknown}" \
    '{ at: $at, kind: "session_end", role: $role, sessionId: $sess }')
else
  TOOL="$(jq -r '.tool_name // empty' <<<"$PAYLOAD")"
  INPUT="$(jq '.tool_input // {}'     <<<"$PAYLOAD")"
  OUTPUT="$(jq '.tool_response // {}' <<<"$PAYLOAD")"

  RECORD=$(jq -nc \
    --arg at "$NOW" \
    --arg role "${SREFLOW_AGENT_ROLE:-unknown}" \
    --arg sess "${SREFLOW_SESSION_ID:-unknown}" \
    --arg tool "$TOOL" \
    --argjson input "$INPUT" \
    --argjson output "$OUTPUT" \
    '{
       at: $at,
       kind: "tool_call",
       role: $role,
       sessionId: $sess,
       tool: $tool,
       input: $input,
       output_summary: ($output | tostring | .[:2000])
     }')
fi

SINK="${SREFLOW_AUDIT_LOG:-/var/log/sreflow/audit.jsonl}"
mkdir -p "$(dirname "$SINK")" 2>/dev/null || true
echo "$RECORD" >> "$SINK"

# If a remote sink is configured, best-effort forward. Failure does not block.
if [[ -n "${SREFLOW_AUDIT_REMOTE_URL:-}" ]]; then
  curl -sS --max-time 2 \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${SREFLOW_AUDIT_TOKEN:-}" \
    --data-binary "$RECORD" \
    "$SREFLOW_AUDIT_REMOTE_URL" >/dev/null 2>&1 || true
fi

exit 0
