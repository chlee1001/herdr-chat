import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AssistantBlock, NormalizedEvent } from "../types.ts";
import { toolContent } from "./tools.ts";

type Tool = { name: string; args: unknown; content: unknown; rawOutput: unknown; ended: boolean; declined: boolean };

/** Maps both live updates and session/load replay, retaining message block indices. */
export class AcpMapper {
  private blocks: AssistantBlock[] = [];
  private open = false;
  private messageId: string | null = null;
  private tools = new Map<string, Tool>();

  finish(): NormalizedEvent[] {
    if (!this.open) return [];
    const last = this.blocks.at(-1);
    const events: NormalizedEvent[] = [];
    if (last && (last.type === "text" || last.type === "thinking")) events.push({ type: "assistant_block_end", index: this.blocks.length - 1, kind: last.type });
    events.push({ type: "assistant_end", content: this.blocks });
    this.blocks = []; this.open = false; this.messageId = null;
    return events;
  }

  decline(id: string): void { const tool = this.tools.get(id); if (tool) tool.declined = true; }

  update(update: SessionUpdate, clientId?: string): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        if (update.content.type !== "text") break;
        if (this.open && update.messageId && this.messageId && update.messageId !== this.messageId) events.push(...this.finish());
        if (!this.open) { this.open = true; this.messageId = update.messageId ?? null; events.push({ type: "assistant_start" }); }
        const kind = update.sessionUpdate === "agent_message_chunk" ? "text" : "thinking";
        let last = this.blocks.at(-1);
        if (!last || last.type !== kind) {
          if (last && (last.type === "text" || last.type === "thinking")) events.push({ type: "assistant_block_end", index: this.blocks.length - 1, kind: last.type });
          this.blocks.push({ type: kind, text: "" });
          events.push({ type: "assistant_block_start", index: this.blocks.length - 1, kind });
        }
        const block = this.blocks[this.blocks.length - 1]!;
        if (block.type !== "toolCall") block.text += update.content.text;
        events.push({ type: "assistant_delta", index: this.blocks.length - 1, kind, delta: update.content.text });
        break;
      }
      case "user_message_chunk":
        events.push(...this.finish());
        if (update.content.type === "text") events.push({ type: "user_message", text: update.content.text, images: 0, ...(clientId ? { clientId } : {}) });
        break;
      case "tool_call": {
        events.push(...this.finish());
        const name = update.kind ?? "other";
        const command = /^\$\s+(.+)$/.exec(update.title)?.[1];
        const diff = update.content?.find((part) => part.type === "diff");
        const fallback = command ? { command } : diff ? { path: diff.path } : update.locations?.[0] ? { path: update.locations[0].path } : {};
        const args = update.rawInput && typeof update.rawInput === "object" && !Array.isArray(update.rawInput) ? { ...fallback, ...update.rawInput } : update.rawInput ?? fallback;
        this.tools.set(update.toolCallId, { name, args, content: update.content ?? [], rawOutput: update.rawOutput, ended: false, declined: false });
        events.push({ type: "tool_call", callId: update.toolCallId, name, args }, { type: "tool_started", callId: update.toolCallId, name, args });
        if (update.status === "completed" || update.status === "failed") events.push(...this.toolUpdate(update));
        break;
      }
      case "tool_call_update": events.push(...this.toolUpdate(update)); break;
      case "plan": events.push({ type: "plan", steps: update.entries.map((e) => ({ text: e.content, status: e.status })) }); break;
      case "usage_update": events.push({ type: "turn_end" }); break;
      case "session_info_update": if (update.title !== undefined) events.push({ type: "session", name: update.title }); break;
    }
    return events;
  }

  private toolUpdate(update: Extract<SessionUpdate, { sessionUpdate: "tool_call_update" | "tool_call" }>): NormalizedEvent[] {
    const tool = this.tools.get(update.toolCallId);
    if (!tool || tool.ended) return [];
    if (update.content != null) tool.content = update.content;
    if (update.rawOutput !== undefined) tool.rawOutput = update.rawOutput;
    const output = toolContent(tool.content);
    if (update.status === "completed" || update.status === "failed") {
      tool.ended = true;
      return [{ type: "tool_ended", callId: update.toolCallId, name: tool.name, args: tool.args, isError: update.status === "failed", output, result: { content: tool.content, rawOutput: tool.rawOutput }, ...(tool.declined ? { declined: true } : {}) }];
    }
    return update.status === "in_progress" ? [{ type: "tool_progress", callId: update.toolCallId, name: tool.name, args: tool.args, output }] : [];
  }
}
