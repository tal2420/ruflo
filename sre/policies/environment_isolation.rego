package sreflow.environment_isolation

# A prod-scoped agent cannot call stage/corp tools, and vice versa.
# corp is a read-only scope for knowledge-graph and ticketing operations
# that have no production side effects. It is never a write-target for
# remediation tools.

default allow = false

allow {
	input.agent.env == input.target.env
}

allow {
	input.agent.env == "corp"
	input.tool_class == "read"
}

deny_reason := sprintf(
	"agent env %q may not call target env %q for class %q",
	[input.agent.env, input.target.env, input.tool_class],
) {
	not allow
}
