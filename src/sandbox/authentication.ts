import { z } from "zod";
import { agentEnv } from "../agents/agent-process.js";
import type { BrokerConnection } from "./broker.js";

const CLAUDE_SUBSCRIPTION_METHOD = "claude.ai";
const CODEX_SUBSCRIPTION_TYPE = "chatgpt";
const AUTH_TIMEOUT_MS = 15_000;
const INITIALIZE_ID = 1;
const ACCOUNT_ID = 2;
const claudeSchema = z.object({ loggedIn: z.literal(true), authMethod: z.literal(CLAUDE_SUBSCRIPTION_METHOD) });
const codexSchema = z.object({ account: z.object({ type: z.literal(CODEX_SUBSCRIPTION_TYPE) }) });
const responseSchema = z.object({ id: z.number().optional(), result: z.unknown().optional(), error: z.unknown().optional() });
type AuthBroker = Pick<BrokerConnection, "run" | "spawn">;

async function claudeAuthenticated(broker: AuthBroker, cwd: string): Promise<boolean> {
  try {
    return claudeSchema.safeParse(JSON.parse(await broker.run("claude", ["auth", "status", "--json"], cwd))).success;
  } catch {
    return false;
  }
}

async function codexAuthenticated(broker: AuthBroker, cwd: string, timeoutMs: number): Promise<boolean> {
  let proc: ReturnType<AuthBroker["spawn"]>;
  try {
    proc = broker.spawn("codex", ["app-server"], { cwd, env: agentEnv({}, "codex") });
  } catch {
    return false;
  }
  try {
    return await new Promise<boolean>(resolve => {
      let done = false;
      const finish = (authenticated: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(authenticated);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      const write = (value: unknown) => {
        try {
          proc.write(JSON.stringify(value));
        } catch {
          finish(false);
        }
      };
      proc.onExit(() => finish(false));
      proc.onLine(line => {
        if (done) return;
        let response: z.infer<typeof responseSchema>;
        try {
          response = responseSchema.parse(JSON.parse(line));
        } catch {
          finish(false);
          return;
        }
        if (response.id !== INITIALIZE_ID && response.id !== ACCOUNT_ID) return;
        if (response.error !== undefined) {
          finish(false);
          return;
        }
        if (response.id === ACCOUNT_ID) {
          finish(codexSchema.safeParse(response.result).success);
          return;
        }
        write({ method: "initialized" });
        if (!done) write({ id: ACCOUNT_ID, method: "account/read", params: {} });
      });
      void proc.spawned
        .then(() => {
          if (!done)
            write({
              id: INITIALIZE_ID,
              method: "initialize",
              params: { clientInfo: { name: "clodex", title: "Clodex", version: "0.0.0" }, capabilities: null },
            });
        })
        .catch(() => finish(false));
    });
  } finally {
    proc.kill();
  }
}

export async function inspectSandboxAuthentication(broker: AuthBroker, cwd: string, timeoutMs = AUTH_TIMEOUT_MS): Promise<{ claude: boolean; codex: boolean }> {
  const [claude, codex] = await Promise.all([claudeAuthenticated(broker, cwd), codexAuthenticated(broker, cwd, timeoutMs)]);
  return { claude, codex };
}
