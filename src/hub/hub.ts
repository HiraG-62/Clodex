// 複数の project の実行環境を持ち、今の project を選ぶ（DESIGN.md §28 D2a）
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../project/atomic-write.js";
import { resolveProjectRoot } from "../project/project-root.js";
import { hasRecoveryWork, loadRecovery } from "../project/recovery-store.js";

const HUB_PATH = join(".clodex", "hub.json");
const savedSchema = z.object({ projects: z.array(z.string()), lastProject: z.string().optional() });

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
  private readonly saved: string[];
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

  list(): Array<{ projectRoot: string; open: boolean; current: boolean }> {
    return this.saved.map((projectRoot) => ({ projectRoot, open: this.contexts.has(projectRoot), current: projectRoot === this.selected }));
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
    writeFileAtomic(this.path, `${JSON.stringify({ projects: this.saved, lastProject: projectRoot }, null, 2)}\n`);
    return context;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.contexts.values()].map((context) => context.close()));
  }
}
