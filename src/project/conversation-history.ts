// 会話（1 回の clodex の起動で使った Claude と Codex の session の組）の履歴（DESIGN.md §18）
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { AgentId } from "../agents/agent-adapter.js";
import type { EventBus } from "../coordinator/event-bus.js";

export const MAX_CONVERSATIONS = 20;
const TITLE_LENGTH = 60;
const STATE_DIR = join(".clodex", "state");
const PATH_HASH_LENGTH = 8;

const sessionsSchema = z.strictObject({ claude: z.string().min(1).optional(), codex: z.string().min(1).optional() });
const conversationSchema = z.strictObject({
  id: z.string().min(1),
  startedAt: z.string(),
  updatedAt: z.string(),
  title: z.string().optional(),
  sessions: sessionsSchema,
});
const stateSchema = z.strictObject({ conversations: z.array(conversationSchema) });

export type SavedSessions = Partial<Record<AgentId, string>>;
export type Conversation = z.infer<typeof conversationSchema>;

// 読める名前だけだと C:\a-b と C:\a\b が衝突するので、パスのハッシュを足す。Windows のパスは大文字小文字を区別しない
export const conversationStatePath = (homeDir: string, projectRoot: string): string => {
  const readable = projectRoot.replace(/[^A-Za-z0-9]/g, "-");
  const hash = createHash("sha256").update(projectRoot.toLowerCase()).digest("hex").slice(0, PATH_HASH_LENGTH);
  return join(homeDir, STATE_DIR, `${readable}-${hash}.json`);
};

// 壊れていても起動は妨げない（空の履歴として扱う）
const loadConversations = (path: string): Conversation[] => {
  if (!existsSync(path)) return [];
  try {
    const parsed = stateSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data.conversations : [];
  } catch {
    return [];
  }
};

const isWorthSaving = (c: Conversation) => Boolean(c.title || c.sessions.claude || c.sessions.codex);
const byNewest = (a: Conversation, b: Conversation) => b.updatedAt.localeCompare(a.updatedAt);

export interface ConversationHistoryOptions {
  resumeLatest: boolean;
  now?: () => Date;
  createId?: () => string;
}

export class ConversationHistory {
  private conversations: Conversation[];
  private current: Conversation;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly switchListeners: Array<(id: string) => void> = [];

  constructor(private readonly path: string, { resumeLatest, now = () => new Date(), createId = randomUUID }: ConversationHistoryOptions) {
    this.now = now;
    this.createId = createId;
    this.conversations = loadConversations(path).sort(byNewest);
    const latest = this.conversations[0];
    this.current = resumeLatest && latest ? latest : this.emptyConversation();
  }

  // /new: 新しい会話を始める。前の会話は履歴に残る（session も入力も無いうちは保存しない）
  startNew(): void {
    this.current = this.emptyConversation();
    this.notifySwitch();
  }

  // 今の会話が変わったとき（/new、/resume）に呼ぶ
  onSwitch(listener: (id: string) => void): void {
    this.switchListeners.push(listener);
  }

  private notifySwitch(): void {
    for (const listener of this.switchListeners) listener(this.current.id);
  }

  // /new <agent>: その Agent の session を今の会話から外して保存する（再起動しても古い session に戻らない）
  clearSession(agent: AgentId): void {
    const { [agent]: _removed, ...rest } = this.current.sessions;
    this.update({ sessions: rest });
  }

  private emptyConversation(): Conversation {
    const startedAt = this.now().toISOString();
    return { id: this.createId(), startedAt, updatedAt: startedAt, sessions: {} };
  }

  get currentId(): string {
    return this.current.id;
  }

  get currentSessions(): SavedSessions {
    return { ...this.current.sessions };
  }

  list(): Conversation[] {
    return [...this.conversations];
  }

  // 選んだ会話を今の会話にする。以後の session と入力はそちらに記録する
  switchTo(id: string): Conversation | undefined {
    const found = this.conversations.find((c) => c.id === id);
    if (!found) return undefined;
    this.current = found;
    this.notifySwitch();
    return found;
  }

  attach(bus: EventBus): () => void {
    return bus.subscribe((event) => {
      if (event.kind === "agent" && event.event.type === "session") {
        this.update({ sessions: { ...this.current.sessions, [event.agent]: event.event.sessionId } });
      }
      if (event.kind === "human" && !this.current.title) {
        this.update({ title: event.text.slice(0, TITLE_LENGTH) });
      }
    });
  }

  private update(change: Partial<Conversation>): void {
    this.current = { ...this.current, ...change, updatedAt: this.now().toISOString() };
    this.conversations = [this.current, ...loadConversations(this.path).filter((c) => c.id !== this.current.id)]
      .filter(isWorthSaving)
      .sort(byNewest)
      .slice(0, MAX_CONVERSATIONS);
    mkdirSync(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tempPath, `${JSON.stringify({ conversations: this.conversations }, null, 2)}\n`);
      renameSync(tempPath, this.path);
    } finally {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    }
  }
}
