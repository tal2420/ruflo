package sreflow.blast_radius

# Input shape:
# {
#   "agent":   { "role": "remediator", "env": "prod" },
#   "tool":    "mcp__k8s__restart_pod",
#   "target":  { "env": "prod", "canonicalEntityId": "...", "businessProcessTier": 1 },
#   "approvals": [ { "human": "alice", "at": "...", "hash": "..." } ],
#   "now":     "2026-04-21T10:00:00Z"
# }
#
# data.sreflow.tool_allowlist is loaded from tool_allowlist.yaml by the OPA bundle.

default allow = false

# The tool must appear in the allowlist.
tool_entry := entry {
  some i
  entry := data.sreflow.tool_allowlist.tools[i]
  entry.name == input.tool
}

# Destructive tools are never allowed through this policy. Break-glass only.
deny_destructive {
  tool_entry.class == "destructive"
}

# Environment of the target must be in the tool's allowed envs.
env_ok {
  some e
  e := tool_entry.envs[_]
  e == input.target.env
}

# The agent's env must match the target's env (cross-env is handled separately).
agent_env_matches {
  input.agent.env == input.target.env
}

# Class-to-approvals lookup for the business-process criticality tier.
required_approvals := n {
  tier := sprintf("tier%d", [input.target.businessProcessTier])
  n := tool_entry.approvals[tier]
}

approvals_ok {
  required_approvals >= 0
  count(input.approvals) >= required_approvals
}

allow {
  tool_entry
  not deny_destructive
  env_ok
  agent_env_matches
  approvals_ok
}

# Structured denial reason for the audit log.
deny_reason := "tool_not_in_allowlist" {
  not tool_entry
}

deny_reason := "destructive_class_blocked" {
  deny_destructive
}

deny_reason := "env_mismatch" {
  tool_entry
  not deny_destructive
  not env_ok
}

deny_reason := "cross_environment_denied" {
  tool_entry
  not deny_destructive
  env_ok
  not agent_env_matches
}

deny_reason := sprintf("insufficient_approvals: need %d, have %d", [required_approvals, count(input.approvals)]) {
  tool_entry
  not deny_destructive
  env_ok
  agent_env_matches
  not approvals_ok
}
