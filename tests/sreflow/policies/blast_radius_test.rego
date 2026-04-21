package sreflow.blast_radius_test

import data.sreflow.blast_radius

# ---------- Shared mock allowlist ----------
# Overrides only data.sreflow.tool_allowlist, not the whole data tree, so
# tests do not recursively reference themselves.
mock_allowlist := {
	"version": "0.1.0",
	"tools": [
		{
			"name": "kg__query",
			"class": "read",
			"envs": ["prod", "stage", "corp"],
			"approvals": {"tier1": 0, "tier2": 0, "tier3": 0},
		},
		{
			"name": "mcp__k8s__restart_pod",
			"class": "write-high",
			"envs": ["prod", "stage"],
			"approvals": {"tier1": 1, "tier2": 1, "tier3": 0},
		},
		{
			"name": "mcp__k8s__scale_deployment",
			"class": "write-high",
			"envs": ["prod", "stage"],
			"approvals": {"tier1": 1, "tier2": 1, "tier3": 1},
		},
		{
			"name": "mcp__k8s__delete_namespace",
			"class": "destructive",
			"envs": [],
			"approvals": {"tier1": -1, "tier2": -1, "tier3": -1},
		},
	],
}

base_input := {
	"agent": {"role": "r", "env": "prod"},
	"target": {"env": "prod", "canonicalEntityId": "c", "businessProcessTier": 1},
	"approvals": [],
	"now": "2026-04-21T10:00:00Z",
}

# ---------- read class ----------
test_read_in_prod_allowed {
	i := object.union(base_input, {"tool": "kg__query"})
	blast_radius.allow with input as i with data.sreflow.tool_allowlist as mock_allowlist
}

test_read_in_stage_allowed {
	i := object.union(base_input, {
		"tool": "kg__query",
		"agent": {"role": "r", "env": "stage"},
		"target": {"env": "stage", "canonicalEntityId": "c", "businessProcessTier": 3},
	})
	blast_radius.allow with input as i with data.sreflow.tool_allowlist as mock_allowlist
}

# ---------- write-high + approvals ----------
test_write_high_tier1_without_approvals_denied {
	i := object.union(base_input, {"tool": "mcp__k8s__restart_pod"})
	not blast_radius.allow with input as i with data.sreflow.tool_allowlist as mock_allowlist
}

test_write_high_tier1_with_one_approval_allowed {
	i := object.union(base_input, {
		"tool": "mcp__k8s__restart_pod",
		"approvals": [{"human": "alice", "at": "2026-04-21T09:59:00Z"}],
	})
	blast_radius.allow with input as i with data.sreflow.tool_allowlist as mock_allowlist
}

test_write_high_tier3_autonomous_allowed {
	# tier-3 restart_pod requires 0 approvals per the allowlist
	i := object.union(base_input, {
		"tool": "mcp__k8s__restart_pod",
		"target": {"env": "prod", "canonicalEntityId": "c", "businessProcessTier": 3},
	})
	blast_radius.allow with input as i with data.sreflow.tool_allowlist as mock_allowlist
}

test_write_high_scale_tier3_requires_approval {
	# scale_deployment requires approval even for tier-3
	i := object.union(base_input, {
		"tool": "mcp__k8s__scale_deployment",
		"target": {"env": "prod", "canonicalEntityId": "c", "businessProcessTier": 3},
	})
	not blast_radius.allow with input as i with data.sreflow.tool_allowlist as mock_allowlist
}

# ---------- destructive is never allowed ----------
test_destructive_always_denied_even_with_approvals {
	i := object.union(base_input, {
		"tool": "mcp__k8s__delete_namespace",
		"approvals": [
			{"human": "alice", "at": "2026-04-21T09:59:00Z"},
			{"human": "bob", "at": "2026-04-21T09:59:30Z"},
		],
	})
	not blast_radius.allow with input as i with data.sreflow.tool_allowlist as mock_allowlist
}

test_destructive_deny_reason_is_explicit {
	i := object.union(base_input, {"tool": "mcp__k8s__delete_namespace"})
	blast_radius.deny_reason == "destructive_class_blocked" with input as i with data.sreflow.tool_allowlist as mock_allowlist
}

# ---------- unknown tool ----------
test_unknown_tool_denied {
	i := object.union(base_input, {"tool": "mcp__some__unlisted_tool"})
	not blast_radius.allow with input as i with data.sreflow.tool_allowlist as mock_allowlist
}

test_unknown_tool_reason {
	i := object.union(base_input, {"tool": "mcp__some__unlisted_tool"})
	blast_radius.deny_reason == "tool_not_in_allowlist" with input as i with data.sreflow.tool_allowlist as mock_allowlist
}

# ---------- cross-environment ----------
test_cross_env_prod_agent_to_stage_denied {
	i := object.union(base_input, {
		"tool": "mcp__k8s__restart_pod",
		"agent": {"role": "r", "env": "prod"},
		"target": {"env": "stage", "canonicalEntityId": "c", "businessProcessTier": 3},
	})
	not blast_radius.allow with input as i with data.sreflow.tool_allowlist as mock_allowlist
}

# corp is shared internal state — prod/stage agents may call corp-scoped tools.
test_prod_agent_writing_corp_kg_allowed {
	corp_allowlist := {
		"version": "0.1.0",
		"tools": [{
			"name": "kg__upsert_entity",
			"class": "write-low",
			"envs": ["corp"],
			"approvals": {"tier1": 0, "tier2": 0, "tier3": 0},
		}],
	}
	i := object.union(base_input, {
		"tool": "kg__upsert_entity",
		"agent": {"role": "collector", "env": "prod"},
		"target": {"env": "corp", "canonicalEntityId": "c", "businessProcessTier": 3},
	})
	blast_radius.allow with input as i with data.sreflow.tool_allowlist as corp_allowlist
}

# ---------- env not in tool's allowed envs ----------
test_env_not_in_tool_envs_denied {
	# kg__query doesn't list "qa" as an allowed env
	i := object.union(base_input, {
		"tool": "kg__query",
		"agent": {"role": "r", "env": "qa"},
		"target": {"env": "qa", "canonicalEntityId": "c", "businessProcessTier": 3},
	})
	not blast_radius.allow with input as i with data.sreflow.tool_allowlist as mock_allowlist
	blast_radius.deny_reason == "env_mismatch" with input as i with data.sreflow.tool_allowlist as mock_allowlist
}
