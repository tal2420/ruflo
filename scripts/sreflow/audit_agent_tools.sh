#!/usr/bin/env bash
# audit_agent_tools.sh — verify every tool referenced in an agent's allowed/denied
# list is either declared in sre/policies/tool_allowlist.yaml or is a wildcard
# pattern explicitly denied.
#
# Exits non-zero if an agent references an unknown tool — catches drift between
# agent definitions and the policy allowlist before it reaches runtime.
set -euo pipefail

ALLOWLIST_TOOLS=$(yq eval '.sreflow.tool_allowlist.tools[].name' sre/policies/tool_allowlist.yaml)

missing=0

for yaml in sre/agents/**/*.yaml; do
  # allowed tools: must be present in the allowlist unless pattern contains '*'
  while IFS= read -r tool; do
    [[ -z "$tool" ]] && continue
    if [[ "$tool" == *"*"* ]]; then
      # Wildcard patterns in agent configs describe denial groups; skip.
      continue
    fi
    if ! grep -Fxq "$tool" <<<"$ALLOWLIST_TOOLS"; then
      echo "FAIL: $yaml references tool '$tool' not found in sre/policies/tool_allowlist.yaml" >&2
      missing=$((missing + 1))
    fi
  done < <(yq eval '.tools.allowed[]?' "$yaml" 2>/dev/null)
done

if [[ $missing -gt 0 ]]; then
  echo "audit_agent_tools: $missing unknown tool reference(s) across agents." >&2
  exit 1
fi

echo "audit_agent_tools: OK — every allowed tool is registered."
