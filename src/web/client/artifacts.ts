// 会話で触れたファイル（成果物）を feed から組み立てる（DESIGN.md §28 v0.3 B）。
// ブラウザへ関数のまま埋め込むため、外部を参照しない 1 つの関数として書く（型の import のみ）
import type { TimelineItem } from "./timeline.js";

export interface Artifact {
  path: string;
  kind: "changed" | "referenced" | "image";
  group: "presented" | "work";
  at: string;
  firstAt: string;
  changed: boolean;
}

// 新しい順、同じパスは 1 つ
export function collectArtifacts(items: readonly TimelineItem[]): Artifact[] {
  const IMAGE_PATH = /(?:[A-Za-z]:)?[\w.~\\/-]*[\w-]\.(?:png|jpe?g|gif|webp)(?![\w])/gi;
  const LINK = /\[[^\]]+\]\((?:<([^>]+)>|([^\s)]+))\)/g;
  const ABSOLUTE_PATH = /(?<![\w:/])(?:[A-Za-z]:[\\/]|~\/|\/)(?:[^\s<>()"'、。]+[\\/]){1,}[^\s<>()"'、。]+/g;
  const found = new Map<string, Artifact>();
  const key = (path: string) => path.replace(/\\/g, "/").toLowerCase();
  const add = (path: string, kind: Artifact["kind"], group: Artifact["group"], at: string) => {
    const k = key(path);
    const previous = found.get(k);
    found.delete(k);
    found.set(k, {
      path,
      kind: group === "presented" ? kind : previous?.group === "presented" ? previous.kind : kind === "changed" || previous?.changed ? "changed" : kind,
      group: group === "presented" || previous?.group === "presented" ? "presented" : "work",
      at,
      firstAt: previous && previous.firstAt < at ? previous.firstAt : at,
      changed: kind === "changed" || previous?.changed === true,
    });
  };
  const presented = (text: string, at: string) => {
    for (const match of text.matchAll(IMAGE_PATH)) add(match[0], "image", "presented", at);
    for (const match of text.matchAll(LINK)) {
      const path = match[1] ?? match[2];
      if (path && !/^https?:\/\//i.test(path)) add(path, /\.(png|jpe?g|gif|webp)$/i.test(path) ? "image" : "referenced", "presented", at);
    }
    for (const match of text.matchAll(ABSOLUTE_PATH)) {
      const path = match[0];
      add(path, /\.(png|jpe?g|gif|webp)$/i.test(path) ? "image" : "referenced", "presented", at);
    }
  };
  const addMessage = (message: Extract<TimelineItem, { kind: "message" }>["message"], at: string) => {
    if (message.spec) add(message.spec, "referenced", "presented", at);
    for (const file of message.files ?? []) add(file, "referenced", "work", at);
    presented(message.body, at);
  };

  for (const item of items) {
    if (item.kind === "turn") {
      for (const step of item.steps) {
        if (step.kind === "tool") for (const file of step.files ?? []) add(file, "changed", "work", item.at);
      }
      presented(item.text, item.at);
      if (item.segment === "closed" && !item.text && item.status === "completed") {
        const lastSay = item.steps.at(-1);
        if (lastSay?.kind === "say") presented(lastSay.text, item.at);
      }
      for (const { message } of item.messages ?? []) addMessage(message, item.at);
    }
    if (item.kind === "message") addMessage(item.message, item.at);
  }
  return [...found.values()].reverse().sort((a, b) => (a.group === b.group ? 0 : a.group === "presented" ? -1 : 1));
}

export function classifyDiffLine(line: string): "add" | "del" | "hunk" | "header" | "" {
  if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) return "header";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "";
}

export function findImagePaths(text: string): string[] {
  const IMAGE_PATH = /(?:[A-Za-z]:)?[\w.~\\/-]*[\w-]\.(?:png|jpe?g|gif|webp)(?![\w])/gi;
  const found = new Map<string, string>();
  for (const match of text.matchAll(IMAGE_PATH)) {
    const path = match[0];
    const key = path.replace(/\\/g, "/").toLowerCase();
    if (!found.has(key)) found.set(key, path);
  }
  return [...found.values()];
}

// 本文を画像のパス（findImagePaths と同じ判定）とそれ以外に分ける。本文のパスをクリックで開けるようにするため
export function splitImagePaths(text: string): Array<{ text: string; path?: string }> {
  const IMAGE_PATH = /(?:[A-Za-z]:)?[\w.~\\/-]*[\w-]\.(?:png|jpe?g|gif|webp)(?![\w])/gi;
  const parts: Array<{ text: string; path?: string }> = [];
  let last = 0;
  for (const match of text.matchAll(IMAGE_PATH)) {
    const start = match.index ?? 0;
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ text: match[0], path: match[0] });
    last = start + match[0].length;
  }
  if (last < text.length || !parts.length) parts.push({ text: text.slice(last) });
  return parts;
}

// project の中なら相対パスで見せる
export function displayPath(path: string, projectRoot: string): string {
  const normalized = path.replace(/\\/g, "/");
  const root = projectRoot.replace(/\\/g, "/").replace(/\/$/, "");
  return normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? normalized.slice(root.length + 1) : normalized;
}
