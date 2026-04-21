package sreflow.freeze_windows_test

import data.sreflow.freeze_windows

# No calendar entries → freeze policy allows.
test_no_calendar_allows {
	freeze_windows.allow with input as {
		"now": "2026-04-21T10:00:00Z",
		"tool_class": "write-high",
		"target": {"env": "prod", "businessProcessTier": 1},
	}
		with data.sreflow.change_calendar as []
}

# Now-time before the freeze window → allow.
test_outside_window_allows {
	cal := [{
		"name": "Peak season",
		"start": "2026-11-27T00:00:00Z",
		"end": "2026-11-30T23:59:00Z",
		"scope": {"tiers": [1, 2], "envs": ["prod"]},
		"allow_classes": ["read"],
	}]
	freeze_windows.allow with input as {
		"now": "2026-04-21T10:00:00Z",
		"tool_class": "write-high",
		"target": {"env": "prod", "businessProcessTier": 1},
	}
		with data.sreflow.change_calendar as cal
}

# Inside a matching window, write-high is denied.
test_inside_window_write_denied {
	cal := [{
		"name": "Peak season",
		"start": "2026-04-20T00:00:00Z",
		"end": "2026-04-22T23:59:00Z",
		"scope": {"tiers": [1, 2], "envs": ["prod"]},
		"allow_classes": ["read"],
	}]
	not freeze_windows.allow with input as {
		"now": "2026-04-21T10:00:00Z",
		"tool_class": "write-high",
		"target": {"env": "prod", "businessProcessTier": 1},
	}
		with data.sreflow.change_calendar as cal
}

# Inside a matching window, read is allowed because class_permitted.
test_inside_window_read_still_allowed {
	cal := [{
		"name": "Peak season",
		"start": "2026-04-20T00:00:00Z",
		"end": "2026-04-22T23:59:00Z",
		"scope": {"tiers": [1, 2], "envs": ["prod"]},
		"allow_classes": ["read"],
	}]
	freeze_windows.allow with input as {
		"now": "2026-04-21T10:00:00Z",
		"tool_class": "read",
		"target": {"env": "prod", "businessProcessTier": 1},
	}
		with data.sreflow.change_calendar as cal
}

# A freeze that doesn't target this tier → allow.
test_freeze_not_targeting_tier_allows {
	cal := [{
		"name": "T3 tooling freeze",
		"start": "2026-04-20T00:00:00Z",
		"end": "2026-04-22T23:59:00Z",
		"scope": {"tiers": [3], "envs": ["prod"]},
		"allow_classes": ["read"],
	}]
	freeze_windows.allow with input as {
		"now": "2026-04-21T10:00:00Z",
		"tool_class": "write-high",
		"target": {"env": "prod", "businessProcessTier": 1},
	}
		with data.sreflow.change_calendar as cal
}

# A freeze for a different environment → allow.
test_freeze_different_env_allows {
	cal := [{
		"name": "Stage freeze",
		"start": "2026-04-20T00:00:00Z",
		"end": "2026-04-22T23:59:00Z",
		"scope": {"tiers": [1, 2], "envs": ["stage"]},
		"allow_classes": ["read"],
	}]
	freeze_windows.allow with input as {
		"now": "2026-04-21T10:00:00Z",
		"tool_class": "write-high",
		"target": {"env": "prod", "businessProcessTier": 1},
	}
		with data.sreflow.change_calendar as cal
}
