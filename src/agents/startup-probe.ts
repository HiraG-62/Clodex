import type { AgentEvent, AgentId, RateLimitWindow } from "./agent-adapter.js";
import { type AgentProcess, agentEnv, type SpawnAgentProcess, spawnAgentProcess } from "./agent-process.js";
import type { ModelCatalog, ModelOption } from "./model-catalog.js";
import { type CodexRateLimits, codexRateLimitEvent } from "./rate-limits.js";

export type { ModelCatalog, ModelOption } from "./model-catalog.js";
export { EMPTY_MODEL_CATALOG } from "./model-catalog.js";

export type RateLimitEvent = Extract<AgentEvent, { type: "rate_limit" }>;
export interface StartupProbe {
  models: ModelCatalog;
  usage: Partial<Record<AgentId, RateLimitEvent>>;
}

const MODEL_LIST_TIMEOUT_MS = 15_000;
const CLAUDE_REQUEST_ID = "model-catalog";
const CLAUDE_USAGE_REQUEST_ID = "startup-usage";
const CODEX_INITIALIZE_ID = 1;
const CODEX_USAGE_ID = 2;
const CODEX_FIRST_LIST_ID = 3;
const CLAUDE_ARGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
const CODEX_ARGS = ["app-server"];
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export const parseClaudeModels = (message: unknown): ModelOption[] => {
  const response = asRecord(asRecord(asRecord(message)?.response)?.response);
  if (!Array.isArray(response?.models)) return [];
  return response.models.flatMap((raw: unknown) => {
    const item = asRecord(raw);
    if (!item || !nonempty(item.value) || !nonempty(item.displayName)) return [];
    const description = nonempty(item.description) ? item.description.split(" · ")[0] : undefined;
    const label = item.value === "default" && description ? `Default (${description})` : item.displayName;
    return [{ value: item.value, label, ...(nonempty(item.resolvedModel) ? { resolved: item.resolvedModel } : {}) }];
  });
};

export const parseCodexModels = (result: unknown): { models: ModelOption[]; nextCursor?: string } => {
  const response = asRecord(result);
  const data = Array.isArray(response?.data) ? response.data : [];
  const models = data.flatMap((raw: unknown) => {
    const item = asRecord(raw);
    return item && item.hidden !== true && nonempty(item.model) && nonempty(item.displayName) ? [{ value: item.model, label: item.displayName }] : [];
  });
  return { models, ...(nonempty(response?.nextCursor) ? { nextCursor: response.nextCursor } : {}) };
};

const claudeUsageWindow = (raw: unknown): RateLimitWindow | undefined => {
  const window = asRecord(raw);
  if (typeof window?.utilization !== "number" || !nonempty(window.resets_at)) return undefined;
  const resetsAt = Date.parse(window.resets_at) / 1000;
  return Number.isFinite(resetsAt) ? { usedPercent: window.utilization, resetsAt } : undefined;
};

export const parseClaudeUsage = (message: unknown): RateLimitEvent => {
  const limits = asRecord(asRecord(asRecord(asRecord(message)?.response)?.response)?.rate_limits);
  const fiveHour = claudeUsageWindow(limits?.five_hour);
  const weekly = claudeUsageWindow(limits?.seven_day);
  return { type: "rate_limit", ...(fiveHour && { fiveHour }), ...(weekly && { weekly }) };
};

export const parseCodexUsage = (result: unknown): RateLimitEvent => {
  const rateLimits = asRecord(asRecord(result)?.rateLimits);
  return codexRateLimitEvent(rateLimits as CodexRateLimits | undefined);
};

interface ProbeOne {
  models: ModelOption[];
  usage?: RateLimitEvent;
}
const fetchOne = async (agent: AgentId, cwd: string, spawn: SpawnAgentProcess, timeoutMs: number): Promise<ProbeOne> => {
  let proc: AgentProcess;
  try {
    proc = spawn(agent, agent === "claude" ? CLAUDE_ARGS : CODEX_ARGS, { cwd, env: agentEnv(process.env, agent) });
  } catch {
    return { models: [] };
  }
  try {
    return await new Promise<ProbeOne>((resolve, reject) => {
      let done = false;
      let requestId = CODEX_FIRST_LIST_ID;
      const collected: ModelOption[] = [];
      let models: ModelOption[] | undefined;
      let usage: RateLimitEvent | undefined;
      const finish = () => {
        if (done || !models || !usage) return;
        done = true;
        clearTimeout(timer);
        resolve({ models, usage });
      };
      const fail = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new Error("model catalog unavailable"));
      };
      const timer = setTimeout(fail, timeoutMs);
      const write = (message: unknown) => proc.write(JSON.stringify(message));
      proc.onExit(fail);
      proc.onLine(line => {
        if (done) return;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        if (agent === "claude") {
          if (message.type !== "control_response") return;
          // request_id は response の内側にある（docs/spikes/model-list.md）
          const responseId = asRecord(message.response)?.request_id;
          if (responseId === CLAUDE_REQUEST_ID) {
            models = parseClaudeModels(message);
            write({ type: "control_request", request_id: CLAUDE_USAGE_REQUEST_ID, request: { subtype: "get_usage" } });
          }
          if (responseId === CLAUDE_USAGE_REQUEST_ID) usage = parseClaudeUsage(message);
          finish();
          return;
        }
        if (message.id === CODEX_INITIALIZE_ID) {
          if (message.error) {
            fail();
            return;
          }
          write({ method: "initialized" });
          write({ id: CODEX_USAGE_ID, method: "account/rateLimits/read" });
          write({ id: requestId, method: "model/list", params: {} });
          return;
        }
        if (message.id === CODEX_USAGE_ID) {
          usage = message.error ? { type: "rate_limit" } : parseCodexUsage(message.result);
          finish();
          return;
        }
        if (message.id !== requestId) return;
        if (message.error) {
          fail();
          return;
        }
        const page = parseCodexModels(message.result);
        collected.push(...page.models);
        if (!page.nextCursor) {
          models = collected;
          finish();
          return;
        }
        requestId++;
        write({ id: requestId, method: "model/list", params: { cursor: page.nextCursor } });
      });
      proc.spawned
        .then(() => {
          if (done) return;
          if (agent === "claude") write({ type: "control_request", request_id: CLAUDE_REQUEST_ID, request: { subtype: "initialize" } });
          else
            write({
              id: CODEX_INITIALIZE_ID,
              method: "initialize",
              params: { clientInfo: { name: "clodex", title: "Clodex", version: "0.0.0" }, capabilities: null },
            });
        })
        .catch(fail);
    });
  } catch {
    return { models: [] };
  } finally {
    proc.kill();
  }
};

export const fetchStartupProbe = async (
  cwd: string,
  spawn: SpawnAgentProcess = spawnAgentProcess,
  timeoutMs = MODEL_LIST_TIMEOUT_MS,
): Promise<StartupProbe> => {
  const [claude, codex] = await Promise.all([fetchOne("claude", cwd, spawn, timeoutMs), fetchOne("codex", cwd, spawn, timeoutMs)]);
  return {
    models: { claude: claude.models, codex: codex.models },
    usage: {
      ...(claude.usage && { claude: claude.usage }),
      ...(codex.usage && { codex: codex.usage }),
    },
  };
};
