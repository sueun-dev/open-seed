/**
 * Agentic Runner — Native tool-calling loop.
 *
 * Instead of: "LLM, give me JSON with toolCalls" → parse → execute
 * Now:        LLM calls tools natively → we execute → send results back → repeat
 *
 * This is the same pattern used by:
 * - Claude Code (Anthropic tool_use)
 * - Codex CLI (OpenAI function calling)
 * - OMO Sisyphus (delegated tool execution)
 *
 * The model keeps calling tools until it decides it's done.
 * No more "empty toolCalls" problem. No more JSON parsing failures.
 */

import type { AgentConfig, NativeToolDef, ProviderResponse, RoleDefinition, ToolCall, ToolResult } from "../core/types.js";
import { ToolRuntime, listToolDefinitions } from "../tools/runtime.js";
import { ApprovalEngine } from "../safety/approval.js";
import { SessionStore } from "../sessions/store.js";
import { ProviderRegistry } from "../providers/registry.js";
import type { RulesEngine } from "../safety/rules-engine.js";
import type { AgentEventBus } from "../core/event-bus.js";
import type { DiffSandbox } from "../tools/diff-sandbox.js";
import type { HookRegistry } from "./hooks.js";
import type { CostTracker } from "./cost-tracker.js";

export interface AgenticRunParams {
  cwd: string;
  sessionId: string;
  taskId: string;
  role: RoleDefinition;
  config: AgentConfig;
  systemPrompt: string;
  userPrompt: string;
  store: SessionStore;
  providerRegistry: ProviderRegistry;
  providerId: string;
  costTracker?: CostTracker;
  rulesEngine?: RulesEngine;
  hooks?: HookRegistry;
  sandbox?: DiffSandbox;
  eventBus?: AgentEventBus;
  maxTurns?: number;
}

export interface AgenticResult {
  summary: string;
  toolResults: ToolResult[];
  totalTurns: number;
  totalToolCalls: number;
}

/**
 * Build native tool definitions from our tool registry.
 */
export function buildNativeTools(role: RoleDefinition): NativeToolDef[] {
  const defs = listToolDefinitions();
  return defs
    .filter(d => role.toolPolicy.allowed.includes(d.name))
    .map(d => ({
      name: d.name,
      description: d.description,
      parameters: d.inputSchema ?? { type: "object", properties: {} }
    }));
}

/**
 * Run the agentic loop — model calls tools, we execute, send results back.
 *
 * Flow:
 * 1. Send system prompt + user prompt + tool definitions to LLM
 * 2. LLM responds with text (done) or tool_calls
 * 3. If tool_calls: execute each one, collect results
 * 4. Send tool results back to LLM as new turn
 * 5. Repeat from step 2 until LLM responds with text only
 */
export async function runAgenticLoop(params: AgenticRunParams): Promise<AgenticResult> {
  const maxTurns = params.maxTurns ?? 15;
  const allToolResults: ToolResult[] = [];
  let totalTurns = 0;
  let finalText = "";

  // Build tool runtime
  const runtime = new ToolRuntime({
    cwd: params.cwd,
    config: params.config,
    role: params.role,
    sessionId: params.sessionId,
    sessionStore: params.store,
    approvalEngine: new ApprovalEngine(params.config.safety),
    rulesEngine: params.rulesEngine,
    hooks: params.hooks,
    sandbox: params.sandbox,
    eventBus: params.eventBus
  });

  // Build conversation history for multi-turn
  const messages: Array<{ role: string; content: string }> = [
    { role: "user", content: params.userPrompt }
  ];

  // Build native tool list
  const nativeTools = buildNativeTools(params.role);

  for (let turn = 0; turn < maxTurns; turn++) {
    totalTurns++;

    // Call LLM with tools
    const response = await params.providerRegistry.invokeWithFailover(
      params.config,
      params.providerId as any,
      {
        role: params.role.id,
        category: params.role.category,
        systemPrompt: params.systemPrompt,
        prompt: messages.map(m => `[${m.role}]: ${m.content}`).join("\n\n"),
        responseFormat: "json",
        tools: nativeTools
      }
    );

    // Track costs
    if (params.costTracker && response.usage) {
      params.costTracker.record({
        taskId: params.taskId,
        roleId: params.role.id,
        providerId: response.provider,
        model: response.model,
        usage: {
          inputTokens: response.usage.inputTokens ?? 0,
          outputTokens: response.usage.outputTokens ?? 0
        }
      });
    }

    const text = response.text.trim();

    // Try to parse as JSON with toolCalls
    let toolCalls: ToolCall[] = [];
    try {
      const parsed = JSON.parse(text);
      if (parsed.toolCalls && Array.isArray(parsed.toolCalls) && parsed.toolCalls.length > 0) {
        toolCalls = parsed.toolCalls.map((tc: any) => ({
          name: tc.name,
          reason: tc.reason || "",
          input: tc.input || tc.arguments || {}
        }));
        finalText = parsed.summary || parsed.kind || "";
      } else {
        // No tool calls — model is done
        finalText = text;
        break;
      }
    } catch {
      // Not JSON — model is done, returned plain text
      finalText = text;
      break;
    }

    if (toolCalls.length === 0) {
      finalText = text;
      break;
    }

    // Execute tool calls
    const results = await runtime.executePlan(toolCalls);
    allToolResults.push(...results);

    // Build tool results message for next turn
    const resultsSummary = results.map(r => {
      const output = r.ok
        ? (typeof r.output === "string" ? r.output : JSON.stringify(r.output)).slice(0, 2000)
        : `ERROR: ${r.error}`;
      return `[${r.name}] ${r.ok ? "OK" : "FAILED"}: ${output}`;
    }).join("\n\n");

    // Add to conversation
    messages.push({
      role: "assistant",
      content: text
    });
    messages.push({
      role: "user",
      content: `Tool results:\n${resultsSummary}\n\nContinue working. If all tools succeeded and the task is complete, respond with a final summary JSON: {"kind":"execution","summary":"...","changes":["..."],"suggestedCommands":[],"toolCalls":[]}\nIf more work is needed, include more toolCalls.`
    });

    // Emit event
    if (params.eventBus) {
      await params.eventBus.fire("tool.completed", "engine", params.sessionId, {
        turn,
        toolCallCount: toolCalls.length,
        successCount: results.filter(r => r.ok).length,
        failCount: results.filter(r => !r.ok).length
      });
    }
  }

  // Parse final text as artifact
  let summary = finalText;
  try {
    const parsed = JSON.parse(finalText);
    summary = parsed.summary || parsed.kind || finalText;
  } catch {
    // plain text summary is fine
  }

  return {
    summary,
    toolResults: allToolResults,
    totalTurns,
    totalToolCalls: allToolResults.length
  };
}
