package sreflow.freeze_windows

# Denies writes during declared change-freeze windows.
# Windows are loaded from data.sreflow.change_calendar — an external data source
# (e.g., a Git-tracked YAML) that the OPA bundle refreshes every 60s.
#
# Example calendar entry:
#   - name: "Black Friday peak"
#     start: "2026-11-27T00:00:00Z"
#     end:   "2026-11-30T23:59:00Z"
#     scope: { tiers: [1, 2], envs: ["prod"] }
#     allow_classes: ["read"]
#
# A write attempted inside a matching window is denied unless its class is listed
# in allow_classes (typically only "read" is allowed).

default allow = true

allow = false {
  some i
  w := data.sreflow.change_calendar[i]
  time.parse_rfc3339_ns(w.start) <= time.parse_rfc3339_ns(input.now)
  time.parse_rfc3339_ns(w.end)   >= time.parse_rfc3339_ns(input.now)
  includes_tier(w, input.target.businessProcessTier)
  includes_env(w, input.target.env)
  not class_permitted(w, input.tool_class)
}

includes_tier(w, t) {
  some i
  w.scope.tiers[i] == t
}

includes_env(w, e) {
  some i
  w.scope.envs[i] == e
}

class_permitted(w, c) {
  some i
  w.allow_classes[i] == c
}
