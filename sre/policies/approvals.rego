package sreflow.approvals

# HITL matrix. Computes the minimum number of distinct humans required to approve
# a proposed action given the criticality tier of the affected business process,
# the blast-radius class of the action, and the environment.
#
# This mirrors (and can be consulted independently of) the approvals already
# encoded in tool_allowlist.yaml. It's used by the commander to compose proposals,
# and by the hook to validate before passing to blast_radius.rego.

default required = 999  # fail closed

# Tier 1 (revenue-critical / regulated): every write requires humans; destructive blocked.
required = 0 { input.class == "read" }

required = 1 { input.class == "write-low"; input.tier == 1 }
required = 2 { input.class == "write-high"; input.tier == 1 }

required = 0 { input.class == "write-low"; input.tier == 2 }
required = 1 { input.class == "write-high"; input.tier == 2 }

required = 0 { input.class == "write-low"; input.tier == 3 }
required = 0 { input.class == "write-high"; input.tier == 3; input.in_envelope == true }
required = 1 { input.class == "write-high"; input.tier == 3; input.in_envelope == false }

# Destructive: not bound, ever. Expressed as infinity.
# required = 999 at default means "never satisfiable by this policy".

two_person_rule {
  input.class == "write-high"
  input.tier == 1
}

two_person_rule {
  input.class == "destructive"
}
