import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { type AgentSendOptions, type AgentStartOptions, type PermissionLevel, summarizeToolInput, type TurnResult } from "./agent-adapter.js";
import { type AgentProcess, agentEnv, agentStartError, type SpawnAgentProcess, spawnAgentProcess } from "./agent-process.js";
import { BaseAgentAdapter } from "./base-agent-adapter.js";

const AGY_COMMAND = "agy";
const STREAM_ARGS = ["--input-format", "stream-json", "--output-format", "stream-json"];
const MODE_ARGS: Record<PermissionLevel, string[]> = {
  "read-only": ["--mode", "plan"],
  edit: ["--mode", "accept-edits"],
  full: ["--dangerously-skip-permissions"],
};
const EDIT_TOOLS = new Set(["write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file"]);
const COMMAND_KEYS = ["command", "command_line", "CommandLine", "Command"];
const FILE_KEYS = ["path", "file_path", "FilePath", "TargetFile", "target_file"];
const IMAGE_PREFIX = "[image] ";

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const firstString = (value: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined => {
  for (const key of keys) if (typeof value?.[key] === "string") return value[key] as string;
  return undefined;
};
const filesIn = (value: unknown): string[] => {
  const item = record(value);
  if (!item) return [];
  const direct = firstString(item, FILE_KEYS);
  const nested = Object.values(item).flatMap(child => (Array.isArray(child) ? child.flatMap(filesIn) : []));
  return [...(direct ? [direct] : []), ...nested];
};
export const findAgy = (env: NodeJS.ProcessEnv): string => {
  const names = process.platform === "win32" ? ["agy.exe", "agy.cmd", "agy"] : ["agy"];
  const path = env.PATH ?? env.Path ?? "";
  for (const dir of path.split(delimiter)) for (const name of names) if (existsSync(join(dir, name))) return join(dir, name);
  const fallback = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "agy", "bin", "agy.exe") : undefined;
  return fallback && existsSync(fallback) ? fallback : AGY_COMMAND;
};

export class AntigravityAdapter extends BaseAgentAdapter {
  readonly id = "gemini";
  private options: AgentStartOptions | undefined;
  private interrupted = false;
  private restartNeeded = false;
  private instructionPending: string | undefined;
  private readonly responses = new Map<number, string>();
  private readonly toolsSeen = new Set<number>();
  private previousInput = 0;
  private previousCached = 0;
  private previousOutput = 0;

  constructor(private readonly spawnProcess: SpawnAgentProcess = spawnAgentProcess) {
    super();
  }

  async start(options: AgentStartOptions): Promise<void> {
    if (this.status !== "stopped") throw new Error(`gemini is ${this.status}`);
    this.options = options;
    this.status = "starting";
    this.launchPermission = this.permission;
    this.instructionPending = options.instructions;
    const args = [
      ...STREAM_ARGS,
      ...MODE_ARGS[this.permission],
      ...(this.model ? ["--model", this.model] : []),
      ...(options.resumeSessionId ? ["--conversation", options.resumeSessionId] : []),
    ];
    const command = findAgy(process.env);
    let proc: AgentProcess | undefined;
    try {
      proc = this.spawnProcess(command, args, {
        cwd: options.cwd,
        env: { ...agentEnv(process.env, this.id), ...(options.mcpUrl ? { CLODEX_MCP_URL: options.mcpUrl } : {}) },
      });
      this.attach(proc);
      await proc.spawned;
    } catch (error) {
      this.status = "stopped";
      this.proc?.kill();
      throw agentStartError(command, error);
    }
    if (this.proc !== proc) return;
    this.status = "idle";
    await this.applyPermissionChangedDuringStart();
  }

  override async send(text: string, images: readonly string[] = [], options?: AgentSendOptions): Promise<TurnResult> {
    if (this.status === "stopped" && this.options) await this.start({ ...this.options, resumeSessionId: this.sessionId });
    if (this.restartNeeded && this.status === "idle") await this.restart();
    return super.send(text, images, options);
  }

  async steer(): Promise<boolean> {
    return false;
  }

  async interrupt(): Promise<void> {
    if (this.status !== "busy") return;
    this.interrupted = true;
    await this.stop();
  }

  protected async applyPermission(): Promise<void> {
    this.restartNeeded = true;
    if (this.status === "idle") await this.restart();
  }

  override async setModel(model: string): Promise<void> {
    await super.setModel(model);
    if (this.status === "stopped") return;
    this.restartNeeded = true;
    if (this.status === "idle") await this.restart();
  }

  private async restart(): Promise<void> {
    if (!this.options) return;
    this.restartNeeded = false;
    if (this.proc) await this.stop();
    await this.start({ ...this.options, resumeSessionId: this.sessionId });
  }

  protected writeTurn(text: string, images: readonly string[]): void {
    this.responses.clear();
    this.toolsSeen.clear();
    const content = [this.instructionPending, text, ...images.map(path => `${IMAGE_PREFIX}${path}`)].filter(Boolean).join("\n\n");
    this.instructionPending = undefined;
    this.proc?.write(JSON.stringify({ event: "user", message: { content } }));
  }

  protected writeCompact(): void {
    this.finishTurn({ status: "completed", text: "" });
  }

  protected handleMessage(message: unknown): void {
    const event = record(message);
    if (!event) return;
    if (event.event === "init") {
      if (typeof event.conversation_id === "string") {
        this.sessionId = event.conversation_id;
        this.emit({ type: "session", sessionId: this.sessionId });
      }
      const init = record(event.init);
      if (!this.model && typeof init?.model === "string") this.model = init.model;
      return;
    }
    if (event.event === "step_update") {
      const step = record(event.step_update);
      if (step) this.handleStep(step);
      return;
    }
    if (event.event !== "result") return;
    const result = record(event.result);
    if (!result) return;
    const usage = record(result.usage);
    if (usage) {
      const input = typeof usage.input_tokens === "number" ? usage.input_tokens : this.previousInput;
      const cached = typeof usage.cache_read_tokens === "number" ? usage.cache_read_tokens : this.previousCached;
      const output = typeof usage.output_tokens === "number" ? usage.output_tokens : this.previousOutput;
      this.emit({
        type: "usage",
        input: Math.max(0, input - this.previousInput - (cached - this.previousCached)),
        cachedInput: Math.max(0, cached - this.previousCached),
        output: Math.max(0, output - this.previousOutput),
      });
      this.emit({ type: "input_total", total: input });
      this.previousInput = input;
      this.previousCached = cached;
      this.previousOutput = output;
    }
    if (Array.isArray(result.denied_actions) && result.denied_actions.length) {
      const names = result.denied_actions.map(action => record(action)?.display_name ?? record(action)?.action ?? "?").join(", ");
      this.emit({ type: "error", message: `gemini: tools denied by permission mode: ${names}` });
    }
    this.finishTurn({ status: result.status === "ERROR" ? "failed" : "completed", text: typeof result.response === "string" ? result.response : "" });
  }

  private handleStep(event: Record<string, unknown>): void {
    if (event.step_type === "agent_response") {
      const index = typeof event.step_index === "number" ? event.step_index : 0;
      const text = `${this.responses.get(index) ?? ""}${typeof event.text_delta === "string" ? event.text_delta : ""}`;
      if (event.state === "DONE") {
        this.responses.delete(index);
        if (text) this.emit({ type: "text", text });
      } else this.responses.set(index, text);
      return;
    }
    if (event.step_type !== "tool") return;
    const tool = record(event.tool_info);
    if (typeof tool?.name !== "string") return;
    const index = typeof event.step_index === "number" ? event.step_index : undefined;
    if (index !== undefined) {
      if (this.toolsSeen.has(index)) return;
      this.toolsSeen.add(index);
    }
    const name = tool.name;
    const params = record(tool.parameters);
    const command = name === "run_command" ? firstString(params, COMMAND_KEYS) : undefined;
    const files = EDIT_TOOLS.has(name) ? filesIn(params) : [];
    this.emit({
      type: "tool",
      name: command === undefined ? name : "command",
      input: summarizeToolInput(tool.parameters),
      ...(command ? { command } : {}),
      ...(files.length ? { files } : {}),
    });
  }

  protected override handleExit(code: number | null): void {
    if (this.interrupted) {
      this.interrupted = false;
      this.finishTurn({ status: "interrupted", text: "" });
    }
    super.handleExit(code);
  }
}
