import { RequestError, type ClientSideConnection } from "@agentclientprotocol/sdk";

/** A GJC SDK answer: the operation's result, or its refusal. `method_not_found` (-32601) means this GJC has no SDK methods. */
export type SdkAnswer = { ok: true; result: Record<string, unknown> } | { ok: false; code: string; message: string };

/** Sends a `_gjc/sdk/control` operation on a session. GJC answers a refusal as `{ok: false, error}`, not as a JSON-RPC error. */
export function control(agent: ClientSideConnection, sessionId: string, operation: string, input: Record<string, unknown>): Promise<SdkAnswer> {
  return call(agent, "_gjc/sdk/control", { sessionId, operation, input });
}

/** Sends a `_gjc/sdk/query` on a session. Its request key is `query` (with `operation` GJC answers "Unknown SDK query: undefined"). */
export function query(agent: ClientSideConnection, sessionId: string, name: string, input: Record<string, unknown> = {}): Promise<SdkAnswer> {
  return call(agent, "_gjc/sdk/query", { sessionId, query: name, input });
}

/** A message waiting in GJC's own queue (`queue.messages.list`). */
export type QueuedMessage = { id: string; text: string; mode: string };

export async function queuedMessages(agent: ClientSideConnection, sessionId: string): Promise<QueuedMessage[] | null> {
  const answer = await query(agent, sessionId, "queue.messages.list");
  if (!answer.ok) return null;
  const items = (answer.result.page as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items)) return null;
  return items.filter((item): item is QueuedMessage => typeof item?.id === "string" && typeof item?.text === "string" && typeof item?.mode === "string");
}

async function call(agent: ClientSideConnection, method: string, params: Record<string, unknown>): Promise<SdkAnswer> {
  let result: Record<string, unknown>;
  try {
    result = await agent.extMethod(method, params);
  } catch (error) {
    if (error instanceof RequestError && error.code === -32601) return { ok: false, code: "method_not_found", message: error.message };
    throw error;
  }
  if (result.ok !== false) return { ok: true, result };
  const error = result.error && typeof result.error === "object" ? result.error as { code?: unknown; message?: unknown } : {};
  return { ok: false, code: String(error.code ?? "unknown"), message: String(error.message ?? "") };
}
