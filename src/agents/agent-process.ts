import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// 1 行 1 JSON の stdio でやり取りする常駐プロセス。テストで差し替えられるよう抽象化する
export interface AgentProcess {
  // 起動に成功したら resolve、実行ファイルが無い等で失敗したら reject
  readonly spawned: Promise<void>;
  write(line: string): void;
  onLine(handler: (line: string) => void): void;
  onExit(handler: (code: number | null) => void): void;
  kill(): void;
}

export interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type SpawnAgentProcess = (command: string, args: string[], options: SpawnOptions) => AgentProcess;

// サブスクリプション認証を守るため、子プロセスに渡さない環境変数（docs/spikes/authentication.md）
const API_KEY_ENV_VARS = new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"]);

// Windows の環境変数名は大文字小文字を区別しないので、大文字で比較する
export const subscriptionEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !API_KEY_ENV_VARS.has(key.toUpperCase())));

export const spawnAgentProcess: SpawnAgentProcess = (command, args, { cwd, env }) => {
  const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  // stderr は v0.1 では使わないが、バッファが詰まらないよう読み捨てる
  child.stderr.resume();
  // 終了後の write で EPIPE が throw されないようにする
  child.stdin.on("error", () => {});
  const spawned = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  // 起動失敗は spawned と onExit で扱う。未処理 rejection にしない
  spawned.catch(() => {});

  return {
    spawned,
    write: (line) => void child.stdin.write(`${line}\n`),
    onLine: (handler) => void lines.on("line", handler),
    onExit: (handler) => {
      let exited = false;
      const once = (code: number | null) => {
        if (exited) return;
        exited = true;
        handler(code);
      };
      child.on("exit", once);
      child.on("error", () => once(null));
    },
    kill: () => void child.kill(),
  };
};
