/** What the CLI loads from an agent YAML file. */
export interface AgentDefinition {
  type: string;
  version?: string;
  layer?: string;
  description?: string;
  capabilities?: string[];
  tools: {
    allowed: string[];
    denied?: string[];
  };
  blast_radius?: "read" | "write-low" | "write-high" | "destructive";
  environments?: string[];
  schedule?: Record<string, string>;
  invocation?: string;
  prompt?: string;
  /** Path of the YAML file, filled in by the loader. */
  sourcePath?: string;
}

export interface Approval {
  human: string;
  at: string;
  hash?: string;
}

export interface AgentContext {
  role: string;
  agentEnv: string;
  targetEnv: string;
  sessionId: string;
  approvals: Approval[];
  dryRun: boolean;
  opaUrl: string;
  auditPath: string;
  now: string;
}

export interface ToolTarget {
  env: string;
  canonicalEntityId?: string;
  businessProcessTier?: number;
}

export interface PolicyDecision {
  allow: boolean;
  deny_reason?: string;
}
