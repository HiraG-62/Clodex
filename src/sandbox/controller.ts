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
  notify?(message: string): void;
  paths(): { projects: string[]; artifacts: string };
  stop(): Promise<void>;
  restart(): Promise<void>;
  save(enabled: boolean): void;
}

export class SandboxController {
  private active = false;
  private available = false;
  private changing = false;
  get enabled(): boolean { return this.active; }
  get usable(): boolean { return !this.active || this.available; }
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
    this.active = true;
    try {
      await this.prepare();
      this.available = true;
    } catch { this.lifecycle.notify?.(t("sandbox.incomplete")); }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (this.changing) throw new Error(t("sandbox.changing"));
    if (this.active === enabled && this.usable) {
      if (!enabled) { await this.platform.release(); await this.platform.close(); }
      return;
    }
    this.changing = true;
    try {
      if (enabled) { await this.platform.setup?.(); await this.prepare(); }
      try { await this.lifecycle.stop(); }
      catch (error) {
        if (enabled) { try { await this.platform.release(); } finally { await this.platform.close(); } }
        throw error;
      }
      if (!enabled) {
        try { await this.platform.release(); await this.platform.close(); }
        catch (error) {
          this.lifecycle.notify?.(t("sandbox.releaseFailed"));
          if (this.active && this.available) {
            this.available = false;
            await this.prepare();
            this.available = true;
            await this.lifecycle.restart();
          }
          throw error;
        }
      }
      this.active = enabled;
      this.available = enabled;
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
    if (this.active && this.available) await this.platform.grant(path, true);
  }
}
