// 複数の project の実行環境を持ち、今の project を選ぶ（DESIGN.md §28 D2a）
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../project/atomic-write.js";
import { resolveProjectRoot } from "../project/project-root.js";
import { hasRecoveryWork, loadRecovery } from "../project/recovery-store.js";
import { ConversationHistory, conversationStatePath, loadConversations, type Conversation } from "../project/conversation-history.js";
import { buildTabs, type ConversationTab, type TabConversation } from "./tabs.js";

const HUB_PATH = join(".clodex", "hub.json");
const savedSchema = z.object({ projects: z.array(z.string()), pinned: z.array(z.string()).optional(), lastProject: z.string().optional() });

export interface HubProjectEntry {
  projectRoot: string;
  open: boolean;
  current: boolean;
  pinned: boolean;
}

// 一覧から外せない理由（DESIGN.md §28 D2a 一覧の整理）
export type ProjectRemoveError = "missing" | "open";

export interface HubProject {
  projectRoot: string;
  close(): Promise<void>;
}

export interface HubOptions<T extends HubProject> {
  homeDir: string;
  cwd: string;
  openProject(projectRoot: string): Promise<T>;
}

export class Hub<T extends HubProject> {
  private readonly contexts = new Map<string, T>();
  private readonly closedConversations = new Map<string, { modified: number; size: number; conversations: Conversation[] }>();
  private saved: string[];
  private pinned: string[];
  private selected: string | undefined;
  private readonly path: string;
  private latestProject: string | undefined;

  constructor(private readonly options: HubOptions<T>) {
    this.path = join(options.homeDir, HUB_PATH);
    let parsed: z.infer<typeof savedSchema> = { projects: [] };
    try {
      if (existsSync(this.path)) parsed = savedSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
    } catch {
      // 壊れた保存先は空の一覧として扱う
    }
    this.saved = [...new Set(parsed.projects)];
    this.pinned = (parsed.pinned ?? []).filter((projectRoot) => this.saved.includes(projectRoot));
    this.latestProject = parsed.lastProject;
  }

  get lastProject(): string | undefined {
    return this.latestProject;
  }

  recoveryProjects(): string[] {
    return this.saved.filter((projectRoot) => {
      const state = loadRecovery(this.options.homeDir, projectRoot);
      return state && Object.values(state.conversations).some(hasRecoveryWork);
    });
  }

  get current(): T | undefined {
    return this.selected ? this.contexts.get(this.selected) : undefined;
  }

  allProjects(): T[] { return [...this.contexts.values()]; }

  list(): HubProjectEntry[] {
    const entries = this.saved.map((projectRoot) => ({
      projectRoot, open: this.contexts.has(projectRoot), current: projectRoot === this.selected, pinned: this.pinned.includes(projectRoot),
    }));
    return [...entries.filter((entry) => entry.pinned), ...entries.filter((entry) => !entry.pinned)];
  }

  private savedConversations(projectRoot: string): Conversation[] {
    const path = conversationStatePath(this.options.homeDir, projectRoot);
    const stats = existsSync(path) ? statSync(path) : undefined;
    const modified = stats?.mtimeMs ?? 0;
    const size = stats?.size ?? 0;
    const cached = this.closedConversations.get(projectRoot);
    if (cached?.modified === modified && cached.size === size) return cached.conversations;
    const conversations = loadConversations(path);
    this.closedConversations.set(projectRoot, { modified, size, conversations });
    return conversations;
  }

  tabs(source: (project: T) => { conversations: readonly TabConversation[]; current: TabConversation }): ConversationTab[] {
    const projects = this.list().map(({ projectRoot }) => {
      const context = this.contexts.get(projectRoot);
      return { projectRoot, conversations: context ? source(context).conversations : this.savedConversations(projectRoot) };
    });
    const context = this.current;
    const current = context ? { projectRoot: context.projectRoot, conversation: source(context).current } : undefined;
    return buildTabs(projects, current);
  }

  conversation(projectRoot: string, id: string, source: (project: T) => { list(): Conversation[] }): Conversation | undefined {
    if (!this.saved.includes(projectRoot)) return undefined;
    const context = this.contexts.get(projectRoot);
    return (context ? source(context).list() : this.savedConversations(projectRoot)).find((conversation) => conversation.id === id);
  }

  unpinConversation(projectRoot: string, id: string, source: (project: T) => Pick<ConversationHistory, "list" | "togglePin">): boolean | undefined {
    if (!this.saved.includes(projectRoot)) return undefined;
    const context = this.contexts.get(projectRoot);
    const history = context ? source(context) : new ConversationHistory(conversationStatePath(this.options.homeDir, projectRoot), { resumeLatest: false });
    const conversation = history.list().find((entry) => entry.id === id);
    if (!conversation) return undefined;
    if (!conversation.pinned) return false;
    const pinned = history.togglePin(id);
    if (!context) this.closedConversations.delete(projectRoot);
    return pinned;
  }

  // 切り替え後のピン止めの状態。一覧に無ければ undefined
  togglePin(projectRoot: string): boolean | undefined {
    if (!this.saved.includes(projectRoot)) return undefined;
    const pinned = !this.pinned.includes(projectRoot);
    this.pinned = pinned ? [...this.pinned, projectRoot] : this.pinned.filter((entry) => entry !== projectRoot);
    this.save();
    return pinned;
  }

  // 開いている project は Agent を止めることになるので外さない
  remove(projectRoot: string): ProjectRemoveError | undefined {
    if (!this.saved.includes(projectRoot)) return "missing";
    if (this.contexts.has(projectRoot)) return "open";
    this.saved = this.saved.filter((entry) => entry !== projectRoot);
    this.pinned = this.pinned.filter((entry) => entry !== projectRoot);
    this.save();
    return undefined;
  }

  async open(path: string): Promise<T> {
    const projectRoot = resolveProjectRoot({ explicitProject: resolve(this.options.cwd, path), cwd: this.options.cwd });
    let context = this.contexts.get(projectRoot);
    if (!context) {
      context = await this.options.openProject(projectRoot);
      this.contexts.set(projectRoot, context);
    }
    this.selected = projectRoot;
    this.latestProject = projectRoot;
    if (!this.saved.includes(projectRoot)) this.saved.push(projectRoot);
    this.save();
    return context;
  }

  private save(): void {
    const saved = { projects: this.saved, pinned: this.pinned, ...(this.latestProject ? { lastProject: this.latestProject } : {}) };
    writeFileAtomic(this.path, `${JSON.stringify(saved, null, 2)}\n`);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.contexts.values()].map((context) => context.close()));
  }
}
