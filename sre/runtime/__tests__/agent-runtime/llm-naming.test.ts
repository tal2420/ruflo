import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  defaultModel,
  needsRename,
  proposeBetterName,
  RenameProposalSchema,
  type BpRenameContext,
} from "../../src/agent-runtime/llm-naming.js";

type MessagesCreateLike = Anthropic["messages"]["create"];

function makeMockClient(
  impl: (args: Parameters<MessagesCreateLike>[0]) => unknown,
): Anthropic {
  const create = vi.fn(async (args: Parameters<MessagesCreateLike>[0]) => impl(args));
  return { messages: { create } } as unknown as Anthropic;
}

function okResponse(overrides: Partial<{ name: string; nameHe: string; rationale: string }> = {}) {
  const body = {
    name: overrides.name ?? "View Test Results",
    nameHe: overrides.nameHe ?? "צפייה בתוצאות בדיקה",
    rationale: overrides.rationale ?? "Test-results viewer hosted in Maccabi Online.",
  };
  return {
    stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify(body) }],
    usage: {
      input_tokens: 123,
      output_tokens: 45,
      cache_creation_input_tokens: 2100,
      cache_read_input_tokens: 0,
    },
  };
}

// -----------------------------------------------------------------------------

describe("proposeBetterName", () => {
  const ctx: BpRenameContext = {
    currentName: "MaccabiTestResults6.API",
    sourceName: "MaccabiTestResults6.API (/MACCABIUTILSTESTRESULTS)",
    scope: "feature",
    hostedIn: "Maccabi Online",
    sampleComponents: ["ReactSiteV4", "MaccabiUtilsSso"],
  };

  it("parses + zod-validates the returned JSON and forwards usage", async () => {
    const client = makeMockClient(() => okResponse());
    const { proposal, usage } = await proposeBetterName(client, ctx);
    // The proposal should also round-trip through the exported schema.
    expect(RenameProposalSchema.safeParse(proposal).success).toBe(true);
    expect(proposal.name).toBe("View Test Results");
    expect(proposal.nameHe).toBe("צפייה בתוצאות בדיקה");
    expect(usage.cache_creation_input_tokens).toBe(2100);
  });

  it("passes a cache_control block on the system prompt", async () => {
    const client = makeMockClient((args) => {
      const sys = args.system;
      expect(Array.isArray(sys)).toBe(true);
      const blocks = sys as Array<{ type: string; cache_control?: unknown }>;
      expect(blocks[blocks.length - 1]!.cache_control).toEqual({ type: "ephemeral" });
      return okResponse();
    });
    await proposeBetterName(client, ctx);
  });

  it("passes a json_schema output format describing the expected fields", async () => {
    const client = makeMockClient((args) => {
      const withSchema = args as unknown as {
        output_config?: { format?: { type?: string; schema?: Record<string, unknown> } };
      };
      const schema = withSchema.output_config?.format;
      expect(schema?.type).toBe("json_schema");
      const props = schema?.schema?.properties as Record<string, unknown>;
      expect(Object.keys(props).sort()).toEqual(["name", "nameHe", "rationale"]);
      return okResponse();
    });
    await proposeBetterName(client, ctx);
  });

  it("embeds the current BP context into the user message as JSON", async () => {
    const client = makeMockClient((args) => {
      const msgs = args.messages;
      const userContent = msgs[0]!.content as string;
      expect(userContent).toContain("MaccabiTestResults6.API");
      expect(userContent).toContain("Maccabi Online");
      expect(userContent).toContain("ReactSiteV4");
      const jsonStart = userContent.indexOf("{");
      const payload = JSON.parse(userContent.slice(jsonStart));
      expect(payload.currentName).toBe("MaccabiTestResults6.API");
      expect(payload.scope).toBe("feature");
      return okResponse();
    });
    await proposeBetterName(client, ctx);
  });

  it("defaults to claude-sonnet-4-6 and respects SREFLOW_RENAME_MODEL", async () => {
    const client = makeMockClient((args) => {
      expect(args.model).toBe("claude-sonnet-4-6");
      return okResponse();
    });
    await proposeBetterName(client, ctx);

    const prev = process.env.SREFLOW_RENAME_MODEL;
    process.env.SREFLOW_RENAME_MODEL = "claude-haiku-4-5";
    try {
      const client2 = makeMockClient((args) => {
        expect(args.model).toBe("claude-haiku-4-5");
        return okResponse();
      });
      await proposeBetterName(client2, ctx);
    } finally {
      if (prev == null) delete process.env.SREFLOW_RENAME_MODEL;
      else process.env.SREFLOW_RENAME_MODEL = prev;
    }
  });

  it("caller can override the model via opts.model", async () => {
    const client = makeMockClient((args) => {
      expect(args.model).toBe("claude-opus-4-7");
      return okResponse();
    });
    await proposeBetterName(client, ctx, { model: "claude-opus-4-7" });
  });

  it("throws a clear error when the response has no text block", async () => {
    const client = makeMockClient(() => ({
      stop_reason: "refusal",
      content: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    }));
    await expect(proposeBetterName(client, ctx)).rejects.toThrow(/no text block/);
  });

  it("throws a clear error when the text block isn't valid JSON", async () => {
    const client = makeMockClient(() => ({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "not json at all {" }],
      usage: { input_tokens: 0, output_tokens: 0 },
    }));
    await expect(proposeBetterName(client, ctx)).rejects.toThrow(/non-JSON/);
  });

  it("throws when the JSON doesn't match the schema", async () => {
    const client = makeMockClient(() => ({
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify({ name: "ok" }) }], // missing fields
      usage: { input_tokens: 0, output_tokens: 0 },
    }));
    await expect(proposeBetterName(client, ctx)).rejects.toThrow(/validation/);
  });
});

describe("needsRename heuristic", () => {
  it.each([
    ["Maccabi.Mdoc.Components.Drugs Approvals", true],
    ["macDiarySharing", true],
    ["OffspringsAndDetailsExtend", true],
    ["Default Web Site:80 (/BookmarksApi)", true],
    ["MaccabiRequestsAndApprovals6", true],
    ["Home Page", false],
    ["Maccabi Online", false],
    ["Medical File", false],
    ["", false],
    ["A" .repeat(50), true],
  ])("needsRename(%j) === %s", (input, expected) => {
    expect(needsRename(input)).toBe(expected);
  });
});

describe("defaultModel", () => {
  it("falls back to sonnet-4-6 when no env is set", () => {
    const prev = process.env.SREFLOW_RENAME_MODEL;
    delete process.env.SREFLOW_RENAME_MODEL;
    try {
      expect(defaultModel()).toBe("claude-sonnet-4-6");
    } finally {
      if (prev != null) process.env.SREFLOW_RENAME_MODEL = prev;
    }
  });
});
