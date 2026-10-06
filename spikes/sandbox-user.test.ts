import { describe, expect, it } from "vitest";
import { Script } from "node:vm";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { brokerSource, directHelper, parseOptions, psQuote, validateTargets, formatTable, cliScript, assessDriveDeny } from "./sandbox-user.js";

describe("Deny 継承の計測結果", () => {
  const project = "E:\\sandbox", other = "E:\\other";
  const denied = (directory: string) => ({ directory, created: false, deleted: false, error: "System.UnauthorizedAccessException" });
  const observations = [{ directory: project, created: true, deleted: true }, denied(other), denied("E:\\")];
  it("project の Allow と別 project・ルートの Deny がそろったときだけ成功", () => {
    expect(assessDriveDeny(project, other, ["E:\\"], observations).status).toBe("成功");
    expect(assessDriveDeny(project, other, ["E:\\"], [...observations.slice(0, 2), { directory: "E:\\", created: true, deleted: true }]).status).toBe("失敗");
    expect(assessDriveDeny(project, other, ["E:\\"], [denied(project), ...observations.slice(1)]).status).toBe("失敗");
  });
  it("存在しないパスのエラーを Deny の成功と扱わない", () => {
    expect(assessDriveDeny(project, other, ["E:\\"], [observations[0]!, { ...denied(other), error: "System.IO.DirectoryNotFoundException" }, denied("E:\\")]).status).toBe("失敗");
  });
  it("Deny の未設定や別ドライブは未計測", () => {
    expect(assessDriveDeny(project, other, [], observations).status).toBe("未計測");
    expect(assessDriveDeny(project, "C:\\other", ["E:\\"], observations).status).toBe("未計測");
  });
});

describe("sandbox-user spike の入力境界", () => {
  it("CLI は明示指定がない限り実行しない", () => {
    const options = parseOptions(["--project", "E:\\dev\\clodex-sandbox-test", "--other-project", "E:\\dev\\Clodex"]);
    expect(options.runCli).toBe(false);
    expect(parseOptions(["--project", "E:\\test", "--other-project", "E:\\other", "--run-cli"]).runCli).toBe(true);
    expect(() => parseOptions(["--unknown"])).toThrow();
    expect(() => parseOptions(["--project"])).toThrow();
  });

  it("本体・ドライブ直下・相互に包含する project を拒否する", () => {
    const validate = (project: string, other = "E:\\dev\\Clodex") =>
      validateTargets(project, other, "E:\\dev\\Clodex", "C:\\Users\\Human");
    expect(() => validate("E:\\dev\\clodex-sandbox-test")).not.toThrow();
    for (const path of ["E:\\", "E:\\dev", "e:\\DEV\\CLODEX", "E:\\dev\\Clodex\\tmp", "C:\\Users\\Human"]) {
      expect(() => validate(path)).toThrow();
    }
    expect(() => validate("E:\\test", "E:\\test\\nested")).toThrow();
  });

  it("PowerShell の文字列中で引用符や式を展開しない", () => {
    expect(psQuote("a'$(whoami)`b")).toBe("'a''$(whoami)`b'");
    const script = cliScript("claude", ["--model", "a'$(whoami)"], "E:\\project");
    expect(script).toContain("'a''$(whoami)'");
    expect(script).toContain("ANTHROPIC_API_KEY");
    expect(script).not.toContain(process.env.USERPROFILE ?? "never-match-profile");
  });
});

describe("sandbox-user spike の出力と broker", () => {
  it.skipIf(process.platform !== "win32")("P/Invoke helper を実行せずコンパイルできる", () => {
    const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Add-Type -TypeDefinition @'\n${directHelper}\n'@`;
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
  it("表のセルの改行と区切りをエスケープする", () => {
    expect(formatTable([{ number: 2, name: "境界", status: "失敗", detail: "a|b\nc" }]))
      .toContain("| 2 | 境界 | 失敗 | a\\|b<br>c |");
  });

  it("broker は外部依存なしの JavaScript として構文解析できる", () => {
    expect(() => new Script(brokerSource)).not.toThrow();
    expect(brokerSource).toContain("127.0.0.1");
    expect(brokerSource).toContain("timingSafeEqual");
    expect(brokerSource).toContain('socket.on("close"');
  });

  it("broker が認証後に stdin/stdout/stderr と終了コードを中継する", async () => {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("port");
    const token = "test-only-token";
    const connected = once(server, "connection");
    const child = spawn(process.execPath, ["-e", brokerSource, String(address.port), token], { windowsHide: true });
    const [socket] = await connected;
    const lines = createInterface({ input: socket });
    const messages: Array<Record<string, unknown>> = [];
    const finished = new Promise<void>((done, fail) => {
      child.once("error", fail);
      lines.on("line", line => {
        const message = JSON.parse(line) as Record<string, unknown>;
        messages.push(message);
        if (message.type === "hello") {
          socket.write(JSON.stringify({ type: "welcome", token }) + "\n");
          socket.write(JSON.stringify({ type: "start", id: 1, command: process.execPath, args: ["-e", "process.stdin.once('data', data => { process.stdout.write(data); process.stderr.write('stderr-ok'); process.exitCode=7; process.stdin.destroy(); })"], cwd: process.cwd() }) + "\n");
        }
        if (message.type === "spawn") socket.write(JSON.stringify({ type: "write", id: 1, data: "日本語\n" }) + "\n");
        if (message.type === "exit") done();
      });
    });
    try {
      await finished;
      const stream = (type: string) => Buffer.concat(messages.filter(m => m.type === type).map(m => Buffer.from(String(m.data), "base64"))).toString();
      expect(stream("stdout")).toBe("日本語\n");
      expect(stream("stderr")).toBe("stderr-ok");
      expect(messages.find(m => m.type === "exit")?.code).toBe(7);
      const exited = once(child, "exit");
      socket.end();
      await exited;
    } finally { socket.destroy(); child.kill(); server.close(); }
  });

  it("broker が token 不一致の命令を拒否する", async () => {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("port");
    const connected = once(server, "connection");
    const child = spawn(process.execPath, ["-e", brokerSource, String(address.port), "expected"], { windowsHide: true });
    const exited = once(child, "exit");
    const [socket] = await connected;
    const lines = createInterface({ input: socket });
    try {
      await once(lines, "line");
      socket.write(JSON.stringify({ type: "welcome", token: "wrong" }) + "\n");
      await exited;
      expect(child.exitCode).toBe(0);
    } finally { socket.destroy(); child.kill(); server.close(); }
  });
});
