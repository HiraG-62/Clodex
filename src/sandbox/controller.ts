import type { SpawnAgentProcess } from "../agents/agent-process.js";
import { t } from "../i18n/i18n.js";

export interface SandboxPlatform {
  setup?(): Promise<void>;
  ready?(): Promise<boolean>;
  uninstall?(): Promise<void>;
  inspect(): Promise<boolean>;
  connect(): Promise<void>;
  grant(path: string, git: boolean): Promise<void>;
  release(): Promise<void>;
  close(): Promise<void>;
  spawn: SpawnAgentProcess;
}

interface SandboxLifecycle {
  paths(): { projects: string[]; artifacts: string };
  stop(): Promise<void>;
  restart(): Promise<void>;
  save(enabled: boolean): void;
}

export class SandboxController {
  private active = false;
  private changing = false;
  get enabled(): boolean { return this.active; }
  constructor(readonly platform: SandboxPlatform, private readonly lifecycle: SandboxLifecycle) {}

  async prepare(): Promise<void> {
    if (!await this.platform.inspect()) throw new Error(t("sandbox.incomplete"));
    try {
      await this.platform.connect();
      const { projects, artifacts } = this.lifecycle.paths();
      for (const path of new Set(projects)) await this.platform.grant(path, true);
      await this.platform.grant(artifacts, false);
    } catch (error) {
      try { await this.platform.release(); } finally { await this.platform.close(); }
      throw error;
    }
  }

  async initialize(): Promise<void> {
    await this.platform.setup?.();
    await this.prepare();
    this.active = true;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (this.changing) throw new Error(t("sandbox.changing"));
    if (this.active === enabled) {
      if (enabled) await this.platform.setup?.();
      return;
    }
    this.changing = true;
    try {
      if (enabled) { await this.platform.setup?.(); await this.prepare(); }
      await this.lifecycle.stop();
      if (!enabled) {
        await this.platform.release();
        await this.platform.close();
      }
      this.active = enabled;
      this.lifecycle.save(enabled);
      await this.lifecycle.restart();
    } finally { this.changing = false; }
  }

  async ready(): Promise<boolean> {
    return this.platform.ready ? this.platform.ready() : this.platform.inspect();
  }

  async uninstall(): Promise<void> {
    if (this.changing) throw new Error(t("sandbox.changing"));
    if (!this.platform.uninstall) throw new Error(t("sandbox.incomplete"));
    this.changing = true;
    try {
      await this.lifecycle.stop();
      await this.platform.uninstall();
      this.active = false;
      this.lifecycle.save(false);
      await this.lifecycle.restart();
    } finally { this.changing = false; }
  }

  async allowWorktree(path: string): Promise<void> {
    if (this.active) await this.platform.grant(path, true);
  }
}
