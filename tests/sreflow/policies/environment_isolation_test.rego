package sreflow.environment_isolation_test

import data.sreflow.environment_isolation

test_same_env_allowed {
	environment_isolation.allow with input as {
		"agent": {"env": "prod"},
		"target": {"env": "prod"},
		"tool_class": "read",
	}
}

test_different_env_denied {
	not environment_isolation.allow with input as {
		"agent": {"env": "prod"},
		"target": {"env": "stage"},
		"tool_class": "read",
	}
}

test_corp_agent_reading_prod_allowed {
	environment_isolation.allow with input as {
		"agent": {"env": "corp"},
		"target": {"env": "prod"},
		"tool_class": "read",
	}
}

test_corp_agent_writing_prod_denied {
	not environment_isolation.allow with input as {
		"agent": {"env": "corp"},
		"target": {"env": "prod"},
		"tool_class": "write-high",
	}
}

test_deny_reason_mentions_both_envs {
	r := environment_isolation.deny_reason with input as {
		"agent": {"env": "prod"},
		"target": {"env": "stage"},
		"tool_class": "read",
	}
	contains(r, "prod")
	contains(r, "stage")
}
