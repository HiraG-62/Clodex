// Web の timeline を端末で読める短い行にする。
import type { TimelineItem } from "../web/client/timeline.js";

const plain = (text: string): string => text
  .replace(/^\s{0,3}#{1,6}\s+/gm, "")
  .replace(/\*\*(.*?)\*\*|__(.*?)__/g, "$1$2")
  .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
  .replace(/`([^`]+)`/g, "$1");

// steps は {count} を含む文言（例: "作業 {count} 件"、"{count} steps"）
export interface TerminalLabels { working: string; completed: string; failed: string; interrupted: string; steps: string; you: string; }
export const terminalLines = (items: readonly TimelineItem[], height: number | undefined, labels: TerminalLabels): string[] => {
  const lines: string[] = [];
  for (const item of items) {
    if (item.kind === "turn") {
      lines.push(`${item.agent} · ${labels[item.status]}`);
      if (item.plan) lines.push(plain(item.plan));
      if (item.steps.length) {
        lines.push(labels.steps.replace("{count}", String(item.steps.length)));
        const last = item.steps[item.steps.length - 1];
        if (last) lines.push(plain(last.kind === "say" ? last.text : `${last.name}: ${last.input}`));
      }
      if (item.text) lines.push(plain(item.text));
    } else if (item.kind === "human") lines.push(`${labels.you} → ${item.agent}: ${plain(item.text)}`);
    else if (item.kind === "output" || item.kind === "notice" || item.kind === "error") lines.push(plain(item.text));
    else lines.push(`${item.message.from} → ${item.message.to}: ${plain(item.message.body)}`);
    lines.push("");
  }
  const expanded = lines.join("\n").trimEnd().split("\n");
  return height === undefined ? expanded : expanded.slice(-Math.max(0, height));
};
