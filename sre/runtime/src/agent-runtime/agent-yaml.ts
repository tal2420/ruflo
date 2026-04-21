import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import type { AgentDefinition } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// runtime/src/agent-runtime → up 4 to repo root (agent-runtime, src, runtime, sre).
const DEFAULT_AGENTS_ROOT = join(__dirname, "../../../agents");

function walkYaml(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        stack.push(full);
      } else if (full.endsWith(".yaml") || full.endsWith(".yml")) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

function validate(def: Partial<AgentDefinition>, path: string): AgentDefinition {
  if (!def || typeof def !== "object") {
    throw new Error(`${path}: not a YAML object`);
  }
  if (!def.type || typeof def.type !== "string") {
    throw new Error(`${path}: missing required field 'type'`);
  }
  if (!def.tools || !Array.isArray(def.tools.allowed)) {
    throw new Error(`${path}: missing tools.allowed[]`);
  }
  return { ...def, sourcePath: path } as AgentDefinition;
}

export function loadAgent(path: string): AgentDefinition {
  const raw = yaml.load(readFileSync(path, "utf8")) as Partial<AgentDefinition>;
  return validate(raw, path);
}

export interface ListAgentsOptions {
  agentsRoot?: string;
}

export function listAgents(opts: ListAgentsOptions = {}): AgentDefinition[] {
  const root = opts.agentsRoot ?? DEFAULT_AGENTS_ROOT;
  return walkYaml(root).map(loadAgent);
}

export function findAgent(role: string, opts: ListAgentsOptions = {}): AgentDefinition {
  const all = listAgents(opts);
  const match = all.find((a) => a.type === role);
  if (!match) {
    const types = all.map((a) => a.type).join(", ");
    throw new Error(`Agent role '${role}' not found. Known: ${types}`);
  }
  return match;
}

export function relAgentPath(def: AgentDefinition, repoRoot: string): string {
  return def.sourcePath ? relative(repoRoot, def.sourcePath) : "<unknown>";
}
