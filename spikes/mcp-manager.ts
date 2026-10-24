import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = mkdtempSync(join(tmpdir(), "clodex-mcp-spike-"));
const claudeHome = join(root, "claude-home");
const codexHome = join(root, "codex-home");
const agyHome = join(root, "agy-home");
const project = join(root, "project");
const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome };

const run = (name: string, args: string[], cwd = project, extraEnv: NodeJS.ProcessEnv = {}): void => {
  const command = name === "agy" ? join(process.env.LOCALAPPDATA ?? "", "agy", "bin", "agy.exe") : process.platform === "win32" ? `${name}.exe` : name;
  const result = spawnSync(command, args, { cwd, env: { ...env, ...extraEnv }, encoding: "utf8" });
  process.stdout.write(`$ ${name} ${args.join(" ")}\nexit=${result.status}\n${result.stdout}${result.stderr}\n`);
};

const showFiles = (dir: string): void => {
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if (!/\.(json|toml)$/.test(path)) continue;
    process.stdout.write(`${path}\n${readFileSync(path, "utf8")}\n`);
  }
};

mkdirSync(project, { recursive: true });
mkdirSync(claudeHome, { recursive: true });
mkdirSync(codexHome, { recursive: true });
mkdirSync(agyHome, { recursive: true });
writeFileSync(join(codexHome, "config.toml"), '# preserve-comment\nmodel = "gpt-6"\n[custom]\nkey = "keep"\n');
process.stdout.write(`temporary root: ${root}\n`);
run("claude", ["--version"]);
run("claude", ["mcp", "add-json", "--scope", "user", "spike-stdio", JSON.stringify({ type: "stdio", command: "node", args: ["server.js"], env: { SPIKE_VALUE: "${SPIKE_VALUE}" } })]);
run("claude", ["mcp", "add-json", "--scope", "project", "spike-http", JSON.stringify({ type: "http", url: "https://example.invalid/mcp" })]);
showFiles(claudeHome);
showFiles(project);
run("claude", ["mcp", "remove", "--scope", "user", "spike-stdio"]);
run("claude", ["mcp", "remove", "--scope", "project", "spike-http"]);
showFiles(claudeHome);
showFiles(project);
run("codex", ["--version"]);
run("codex", ["mcp", "add", "spike-stdio", "--env", "SPIKE_VALUE=${SPIKE_VALUE}", "--", "node", "server.js"]);
run("codex", ["mcp", "add", "spike-http", "--url", "https://example.invalid/mcp"]);
run("codex", ["mcp", "add", "spike-http", "--url", "https://example.invalid/updated"]);
run("codex", ["mcp", "list", "--json"]);
showFiles(codexHome);
const agyEnv = { HOME: agyHome, USERPROFILE: agyHome };
run("agy", ["--version"], project, agyEnv);
run("agy", ["mcp", "list"], project, agyEnv);
run("agy", ["mcp", "add", "--env", "SPIKE_VALUE=${SPIKE_VALUE}", "spike-stdio", "node", "server.js"], project, agyEnv);
run("agy", ["mcp", "add", "spike-http", "https://example.invalid/mcp"], project, agyEnv);
showFiles(agyHome);
run("agy", ["mcp", "remove", "spike-stdio"], project, agyEnv);
run("agy", ["mcp", "remove", "spike-http"], project, agyEnv);
showFiles(agyHome);
run("codex", ["mcp", "remove", "spike-stdio"]);
run("codex", ["mcp", "remove", "spike-http"]);
showFiles(codexHome);
