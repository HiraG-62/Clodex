// clodex を起動し直しても会話を続けられるよう、各 Agent の session ID を保存する（DESIGN.md §18）
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { AgentId } from "../agents/agent-adapter.js";
import type { EventBus } from "../coordinator/event-bus.js";

export type SavedSessions = Partial<Record<AgentId, string>>;

const STATE_DIR = join(".clodex", "state");
const PATH_HASH_LENGTH = 8;
const sessionsSchema = z.strictObject({ claude: z.string().min(1).optional(), codex: z.string().min(1).optional() });

// 読める名前だけだと C:\a-b と C:\a\b が衝突するので、パスのハッシュを足す。Windows のパスは大文字小文字を区別しない
export const sessionStatePath = (homeDir: string, projectRoot: string): string => {
  const readable = projectRoot.replace(/[^A-Za-z0-9]/g, "-");
  const hash = createHash("sha256").update(projectRoot.toLowerCase()).digest("hex").slice(0, PATH_HASH_LENGTH);
  return join(homeDir, STATE_DIR, `${readable}-${hash}.json`);
};

// 壊れていても起動は妨げない（新しい session で始めるだけ）
export const loadSessions = (path: string): SavedSessions => {
  if (!existsSync(path)) return {};
  try {
    const parsed = sessionsSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
};

const save = (path: string, sessions: SavedSessions) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sessions)}\n`);
};

// initial: --resume なら読み込んだ内容、そうでなければ {}。
// 起動時に保存し直し、今回の実行と前回の実行の session が混ざらないようにする
export const attachSessionStore = (bus: EventBus, path: string, initial: SavedSessions): (() => void) => {
  let sessions = initial;
  save(path, sessions);
  return bus.subscribe((event) => {
    if (event.kind !== "agent" || event.event.type !== "session") return;
    sessions = { ...sessions, [event.agent]: event.event.sessionId };
    save(path, sessions);
  });
};
