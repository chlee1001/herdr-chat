import { diffFromEdits, relPath, type ToolMap } from "../../tools.ts";

export const ACP_TOOLS: ToolMap = {
  names: { read: "read", edit: "edit", delete: "edit", move: "edit", execute: "bash", search: "search", fetch: "web_fetch" },
  applyResult(detail, result, cwd) {
    if (detail.type !== "edit" || !Array.isArray(result.content)) return undefined;
    const diff = result.content.find((c: any) => c?.type === "diff" && typeof c.path === "string");
    if (!diff) return undefined;
    return { ...detail, path: diff.path, diff: diffFromEdits(relPath(diff.path, cwd), diff) };
  },
};

export function toolContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((part: any) => part?.type === "content" && part.content?.type === "text" ? part.content.text : "").filter(Boolean).join("\n");
}
