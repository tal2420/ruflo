import type { AgentContext } from "./types.js";
import { dynatraceCollector } from "./agents/dynatrace-collector.js";
import { entityResolverAgent } from "./agents/entity-resolver.js";

export interface AgentImpl {
  role: string;
  description: string;
  run: (ctx: AgentContext) => Promise<{ summary: string }>;
}

const IMPLS: Record<string, AgentImpl> = {
  "dynatrace-collector": dynatraceCollector,
  "entity-resolver": entityResolverAgent,
};

export function getImpl(role: string): AgentImpl | null {
  return IMPLS[role] ?? null;
}

export function runnableRoles(): string[] {
  return Object.keys(IMPLS).sort();
}
