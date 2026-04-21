package sreflow.approvals_test

import data.sreflow.approvals

# ---------- read never requires approvals ----------
test_read_tier1_requires_zero {
	approvals.required == 0 with input as {"class": "read", "tier": 1}
}

test_read_tier3_requires_zero {
	approvals.required == 0 with input as {"class": "read", "tier": 3}
}

# ---------- write-low ----------
test_write_low_tier1_requires_one {
	approvals.required == 1 with input as {"class": "write-low", "tier": 1}
}

test_write_low_tier2_requires_zero {
	approvals.required == 0 with input as {"class": "write-low", "tier": 2}
}

test_write_low_tier3_requires_zero {
	approvals.required == 0 with input as {"class": "write-low", "tier": 3}
}

# ---------- write-high ----------
test_write_high_tier1_requires_two {
	approvals.required == 2 with input as {"class": "write-high", "tier": 1}
}

test_write_high_tier2_requires_one {
	approvals.required == 1 with input as {"class": "write-high", "tier": 2}
}

test_write_high_tier3_in_envelope_requires_zero {
	approvals.required == 0 with input as {"class": "write-high", "tier": 3, "in_envelope": true}
}

test_write_high_tier3_out_of_envelope_requires_one {
	approvals.required == 1 with input as {"class": "write-high", "tier": 3, "in_envelope": false}
}

# ---------- destructive is never satisfiable ----------
test_destructive_tier1_returns_default {
	# default required = 999 means "never satisfiable by this policy"
	approvals.required == 999 with input as {"class": "destructive", "tier": 1}
}

# ---------- two-person rule ----------
test_two_person_rule_applies_to_tier1_write_high {
	approvals.two_person_rule with input as {"class": "write-high", "tier": 1}
}

test_two_person_rule_applies_to_destructive {
	approvals.two_person_rule with input as {"class": "destructive", "tier": 3}
}

test_two_person_rule_does_not_apply_to_read {
	not approvals.two_person_rule with input as {"class": "read", "tier": 1}
}

test_two_person_rule_does_not_apply_to_tier3_write_high {
	not approvals.two_person_rule with input as {"class": "write-high", "tier": 3}
}
