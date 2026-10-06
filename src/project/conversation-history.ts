// 会話（1 回の clodex の起動で使った Claude と Codex の session の組）の履歴（DESIGN.md §18）
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AgentId } from "../agents/agent-adapter.js";
import type { EventBus } from "../coordinator/event-bus.js";
import { t } from "../i18n/i18n.js";
import { writeFileAtomic } from "./atomic-write.js";

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
  pinned: z.boolean().optional(),
  // worktree で作業する会話の作業場所とブランチ（DESIGN.md §28 D1）
  workDir: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
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

const isWorthSaving = (c: Conversation) => Boolean(c.title || c.workDir || c.sessions.claude || c.sessions.codex);
const byNewest = (a: Conversation, b: Conversation) => b.updatedAt.localeCompare(a.updatedAt);
// ピン止めした会話は先頭に並べ、最大件数の枠に数えない
const arrange = (conversations: Conversation[]): Conversation[] => {
  const saved = conversations.filter(isWorthSaving).sort(byNewest);
  return [...saved.filter((c) => c.pinned), ...saved.filter((c) => !c.pinned).slice(0, MAX_CONVERSATIONS)];
};

export interface ConversationHistoryOptions {
  resumeLatest: boolean;
  resumeId?: string;
  now?: () => Date;
  createId?: () => string;
}

export class ConversationHistory {
  private conversations: Conversation[];
  private currentConversation: Conversation;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly switchListeners: Array<(id: string) => void> = [];
  private readonly removeListeners: Array<(id: string) => void> = [];

  constructor(private readonly path: string, { resumeLatest, resumeId, now = () => new Date(), createId = randomUUID }: ConversationHistoryOptions) {
    this.now = now;
    this.createId = createId;
    this.conversations = arrange(loadConversations(path));
    const latest = this.conversations[0];
    this.currentConversation = resumeId !== undefined
      ? this.conversations.find((c) => c.id === resumeId) ?? this.emptyConversation()
      : resumeLatest && latest ? latest : this.emptyConversation();
  }

  // /new: 新しい会話を始める。前の会話は履歴に残る（session も入力も作業場所も無いうちは保存しない）
  startNew(place: Pick<Conversation, "workDir" | "branch"> = {}): void {
    this.currentConversation = { ...this.emptyConversation(), ...place };
    if (place.workDir) this.save((list) => list);
    this.notifySwitch();
  }

  // 今の会話が変わったとき（/new、/resume）に呼ぶ
  onSwitch(listener: (id: string) => void): void {
    this.switchListeners.push(listener);
  }

  // 会話を削除したとき（/delete）に呼ぶ
  onRemove(listener: (id: string) => void): void {
    this.removeListeners.push(listener);
  }

  // /rename: 今の会話の名前を変える
  rename(title: string): void {
    this.update({ title: title.slice(0, TITLE_LENGTH) });
  }

  // /pin: ピン止めを切り替え、切り替え後の状態を返す。無い会話なら undefined
  togglePin(id: string): boolean | undefined {
    const found = id === this.currentConversation.id ? this.currentConversation : this.conversations.find((c) => c.id === id);
    if (!found) return undefined;
    const pinned = !found.pinned;
    const { pinned: _old, ...rest } = found;
    const changed: Conversation = pinned ? { ...rest, pinned } : rest;
    if (id === this.currentConversation.id) this.currentConversation = changed;
    this.save((list) => list.map((c) => (c.id === id ? changed : c)));
    return pinned;
  }

  // /delete: 今の会話以外を削除する。削除できなければ理由を返す
  remove(id: string): string | undefined {
    if (id === this.currentConversation.id) return t("reject.deleteCurrent");
    if (!this.conversations.some((c) => c.id === id)) return t("reject.notFound");
    this.save((list) => list.filter((c) => c.id !== id));
    for (const listener of this.removeListeners) listener(id);
    return undefined;
  }

  private notifySwitch(): void {
    for (const listener of this.switchListeners) listener(this.currentConversation.id);
  }

  // /new <agent>: その Agent の session を今の会話から外して保存する（再起動しても古い session に戻らない）
  clearSession(agent: AgentId): void {
    const { [agent]: _removed, ...rest } = this.currentConversation.sessions;
    this.update({ sessions: rest });
  }

  clearAllSessions(): void {
    this.currentConversation = { ...this.currentConversation, title: this.currentConversation.title ?? t("shell.untitled"), sessions: {} };
    this.save((list) => list.map((conversation) => ({ ...conversation, title: conversation.title ?? t("shell.untitled"), sessions: {} })));
  }

  private emptyConversation(): Conversation {
    const startedAt = this.now().toISOString();
    return { id: this.createId(), startedAt, updatedAt: startedAt, sessions: {} };
  }

  get currentId(): string {
    return this.currentConversation.id;
  }

  // 今の会話（作業場所の確認などに使う）
  get current(): Conversation {
    return this.currentConversation;
  }

  get currentSessions(): SavedSessions {
    return { ...this.currentConversation.sessions };
  }

  list(): Conversation[] {
    return [...this.conversations];
  }

  // 選んだ会話を今の会話にする。以後の session と入力はそちらに記録する
  switchTo(id: string): Conversation | undefined {
    const found = this.conversations.find((c) => c.id === id);
    if (!found) return undefined;
    this.currentConversation = found;
    this.notifySwitch();
    return found;
  }

  // conversationId を渡すと、その会話の Event Bus として記録する（会話ごとに Coordinator を持つ。DESIGN.md §28 D1）。
  // 省略すると、その時点の今の会話に記録する
  attach(bus: EventBus, conversationId?: string): () => void {
    return bus.subscribe((event) => {
      const id = conversationId ?? this.currentConversation.id;
      const target = this.find(id);
      if (!target) return;
      if (event.kind === "agent" && event.event.type === "session") {
        this.updateConversation(id, { sessions: { ...target.sessions, [event.agent]: event.event.sessionId } });
      }
      if (event.kind === "human" && !target.title) {
        this.updateConversation(id, { title: event.text.slice(0, TITLE_LENGTH) });
      }
    });
  }

  private find(id: string): Conversation | undefined {
    return id === this.currentConversation.id ? this.currentConversation : this.conversations.find((c) => c.id === id);
  }

  private updateConversation(id: string, change: Partial<Conversation>): void {
    if (id === this.currentConversation.id) return this.update(change);
    const updatedAt = this.now().toISOString();
    this.save((list) => list.map((c) => (c.id === id ? { ...c, ...change, updatedAt } : c)));
  }

  private update(change: Partial<Conversation>): void {
    this.currentConversation = { ...this.currentConversation, ...change, updatedAt: this.now().toISOString() };
    this.save((list) => list);
  }

  // 他のプロセスの会話を消さないよう、書く直前に読み直して今の会話を重ねる
  private save(edit: (conversations: Conversation[]) => Conversation[]): void {
    const others = loadConversations(this.path).filter((c) => c.id !== this.currentConversation.id);
    this.conversations = arrange(edit([this.currentConversation, ...others]));
    writeFileAtomic(this.path, `${JSON.stringify({ conversations: this.conversations }, null, 2)}\n`);
  }
}
