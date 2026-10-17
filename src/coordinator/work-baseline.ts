import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { isAbsolute, join, matchesGlob, relative } from "node:path";
import type { AgentEvent, AgentId } from "../agents/agent-adapter.js";
import type { ClodexConfig } from "../config/config.js";
import { splitSections } from "../context/spec-sections.js";
import { safeGitArgs } from "../project/safe-git.js";
import type { AgentMessage, ChangedFile, VerificationCheck, VerificationEvidence } from "../protocol/messages.js";

const GIT_TIMEOUT_MS = 10_000;
const MAX_CHANGED_FILES = 100;
const STATUS_PATH_OFFSET = 3;
type CheckRecord = VerificationCheck & { toolId?: string };
interface Baseline {
  head: string;
  dirty: Map<string, string | null>;
  from: AgentId;
  to: AgentId;
  active: boolean;
  checks: CheckRecord[];
  peer: Set<string>;
  scope?: { owned: string[]; forbidden: string[] };
}

const normalize = (path: string) => path.replaceAll("\\", "/").replace(/^\.\//, "");
const hash = (content: Buffer | string) => createHash("sha256").update(content).digest("hex");
const fileHash = (path: string): string | null => {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return hash(readlinkSync(path));
    return stat.isFile() ? hash(readFileSync(path)) : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const patterns = (spec: string, heading: string | undefined): string[] => {
  if (heading === undefined) return [];
  return splitSections(spec)
    .filter(section => section.heading.replace(/^#{1,6}\s+/, "").startsWith(heading))
    .flatMap(section =>
      section.content
        .split(/\r?\n/)
        .filter(line => /^\s*[-*+]\s/.test(line))
        .flatMap(line => [...line.matchAll(/`([^`]+)`/g)].map(match => normalize(match[1]!))),
    );
};

export class WorkBaselines {
  private readonly baselines = new Map<string, Baseline>();
  private readonly delivered = new Set<string>();
  constructor(
    private readonly root: string,
    private readonly config: Pick<ClodexConfig, "verify" | "specSections"> = {},
  ) {}

  private git(...args: string[]): Buffer {
    return execFileSync("git", safeGitArgs(args), { cwd: this.root, timeout: GIT_TIMEOUT_MS, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  }

  private status(): string[] {
    const entries = this.git("status", "--porcelain=v1", "-z", "--untracked-files=all").toString("utf8").split("\0");
    const paths: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (!entry) continue;
      paths.push(normalize(entry.slice(STATUS_PATH_OFFSET)));
      if (/[RC]/.test(entry.slice(0, 2)) && entries[i + 1]) paths.push(normalize(entries[++i]!));
    }
    return paths;
  }

  start(message: AgentMessage, spec?: string): void {
    if (message.type !== "DELEGATE" || this.delivered.has(message.id)) return;
    this.baselines.delete(message.id);
    try {
      const head = this.git("rev-parse", "HEAD").toString("utf8").trim();
      const dirty = new Map(this.status().map(path => [path, fileHash(join(this.root, path))]));
      const sections = this.config.specSections;
      this.baselines.set(message.id, {
        head,
        dirty,
        from: message.from,
        to: message.to,
        active: true,
        peer: new Set(),
        checks: (this.config.verify?.implement ?? []).map(command => ({ command, ran: false })),
        ...(sections && spec !== undefined ? { scope: { owned: patterns(spec, sections.owned), forbidden: patterns(spec, sections.forbidden) } } : {}),
      });
    } catch {
      // 基準点が取れない場所でも依頼は配送する。
    }
  }

  resume(requestId: string): void {
    const baseline = this.baselines.get(requestId);
    if (baseline) baseline.active = true;
  }

  markSent(requestId: string): void {
    this.delivered.add(requestId);
  }

  record(agent: AgentId, event: AgentEvent): void {
    if (event.type === "tool") this.recordPeerFiles(agent, event.files ?? []);
    for (const baseline of this.baselines.values()) {
      if (!baseline.active) continue;
      if (agent !== baseline.to) continue;
      if (event.type === "tool_end") {
        for (const check of baseline.checks) {
          if (check.toolId !== event.toolId) continue;
          if (event.exitCode !== undefined) check.exitCode = event.exitCode;
          if (event.failed !== undefined) check.failed = event.failed;
        }
      }
      if (event.type !== "tool") continue;
      const command = event.name === "command" ? (event.command ?? event.input) : event.name === "Bash" ? event.command : undefined;
      if (command === undefined) continue;
      baseline.checks = baseline.checks.map(check =>
        command.includes(check.command)
          ? {
              command: check.command,
              ran: true,
              ...(event.toolId !== undefined ? { toolId: event.toolId } : {}),
              ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
            }
          : check,
      );
    }
  }

  recordPeerFiles(agent: AgentId, files: readonly string[]): void {
    for (const baseline of this.baselines.values()) {
      if (!baseline.active || baseline.from !== agent) continue;
      for (const file of files) baseline.peer.add(normalize(isAbsolute(file) ? relative(this.root, file) : file));
    }
  }

  finish(requestId: string): VerificationEvidence | undefined {
    const baseline = this.baselines.get(requestId);
    if (!baseline) return undefined;
    baseline.active = false;
    try {
      const candidates = new Set([
        ...this.git("diff", "--name-only", "-z", baseline.head, "--").toString("utf8").split("\0").filter(Boolean),
        ...this.status(),
        ...baseline.dirty.keys(),
      ]);
      const tracked = new Set(this.git("ls-tree", "-r", "--name-only", "-z", baseline.head).toString("utf8").split("\0"));
      const changed: ChangedFile[] = [];
      for (const path of [...candidates].sort()) {
        let previous = baseline.dirty.get(path);
        if (previous === undefined) {
          // 新しいファイルは基準点の tree に存在しない。
          previous = tracked.has(path) ? hash(this.git("show", `${baseline.head}:${path}`)) : null;
        }
        if (fileHash(join(this.root, path)) === previous) continue;
        const scope = baseline.scope;
        changed.push({
          path,
          ...(scope
            ? {
                scope: scope.forbidden.some(pattern => matchesGlob(path, pattern))
                  ? ("forbidden" as const)
                  : scope.owned.some(pattern => matchesGlob(path, pattern))
                    ? ("owned" as const)
                    : ("outside" as const),
              }
            : {}),
          ...(baseline.peer.has(path) ? { peer: true as const } : {}),
        });
      }
      return {
        checks: baseline.checks.map(({ toolId: _toolId, ...check }) => check),
        changed: changed.length > MAX_CHANGED_FILES ? { count: changed.length } : changed,
      };
    } catch {
      return undefined;
    }
  }
}
