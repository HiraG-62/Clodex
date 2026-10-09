import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { type CommandProcess, createCommandRunner, EXIT_CODE_SUFFIX, UTF8_PREFIX } from "./command-runner.js";

class FakeProcess extends EventEmitter implements CommandProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  constructor(readonly pid: number | undefined) {
    super();
  }
  close(code: number | null) {
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit("close", code));
  }
}

const flush = () => new Promise(resolve => setImmediate(resolve));

const setup = (missing: string[] = []) => {
  const printed: string[] = [];
  const lifecycle: Array<{ id: number; phase: "start" | "exit" }> = [];
  const spawned: Array<{ file: string; args: string[]; cwd: string }> = [];
  const processes: FakeProcess[] = [];
  const killed: number[] = [];
  let time = 0;
  const runner = createCommandRunner({
    cwd: "C:\\app",
    print: (line, command) => {
      printed.push(line);
      if (command) lifecycle.push(command);
    },
    spawnShell: (file, args, cwd) => {
      spawned.push({ file, args, cwd });
      const child = new FakeProcess(100 + spawned.length);
      if (missing.includes(file)) {
        // 実際の Node と同じく error の後に close も来る
        setImmediate(() => {
          child.emit("error", Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" }));
          child.emit("close", -4058);
        });
      } else {
        processes.push(child);
      }
      return child;
    },
    killTree: pid => killed.push(pid),
    now: () => time,
  });
  return {
    runner,
    printed,
    lifecycle,
    spawned,
    processes,
    killed,
    advance: (ms: number) => {
      time += ms;
    },
  };
};

describe("createCommandRunner", () => {
  it("並行 command の開始・終了に同じ ID を付け、通常出力には付けない", async () => {
    const { runner, lifecycle, processes } = setup();
    const first = runner.run("first");
    const second = runner.run("second");
    processes[0]!.stdout.write("error: output\nexit 0 (1s)\n");
    expect(lifecycle).toEqual([
      { id: 1, phase: "start" },
      { id: 2, phase: "start" },
    ]);
    processes[1]!.close(0);
    await second;
    processes[0]!.close(1);
    await first;
    expect(lifecycle).toEqual([
      { id: 1, phase: "start" },
      { id: 2, phase: "start" },
      { id: 2, phase: "exit" },
      { id: 1, phase: "exit" },
    ]);
  });

  it("終了時に終了コード・停止の有無・出力の行を返す", async () => {
    const { runner, processes } = setup();
    const done = runner.run("pnpm test");
    processes[0]!.stdout.write("line 1\nline 2\n");
    processes[0]!.close(1);
    await expect(done).resolves.toEqual({ code: 1, stopped: false, output: ["line 1", "line 2"] });
    const stopped = setup();
    const long = stopped.runner.run("long");
    stopped.runner.stopAll();
    stopped.processes[0]!.close(1);
    await expect(long).resolves.toMatchObject({ stopped: true });
  });

  it("起動失敗・停止でも開始時と同じ ID で終了を通知する", async () => {
    const failed = setup(["pwsh", "powershell"]);
    await failed.runner.run("missing");
    expect(failed.lifecycle).toEqual([
      { id: 1, phase: "start" },
      { id: 1, phase: "exit" },
    ]);
    const stopped = setup();
    const done = stopped.runner.run("long");
    stopped.runner.stopAll();
    stopped.processes[0]!.close(1);
    await done;
    expect(stopped.lifecycle).toEqual([
      { id: 1, phase: "start" },
      { id: 1, phase: "exit" },
    ]);
  });
  it("project root で pwsh を UTF-8 指定付きで起動し、出力を行ごとに表示して終了コードを出す", async () => {
    const { runner, printed, spawned, processes, advance } = setup();
    const done = runner.run("git status");
    const encoded = Buffer.from(`git status${EXIT_CODE_SUFFIX}`, "utf8").toString("base64");
    const script = `${UTF8_PREFIX}. ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))))${EXIT_CODE_SUFFIX}`;
    expect(spawned).toEqual([{ file: "pwsh", args: ["-NoProfile", "-NonInteractive", "-Command", script], cwd: "C:\\app" }]);
    expect(runner.running).toBe(1);

    const child = processes[0]!;
    // 複数バイト文字が chunk の境界で分かれても化けない
    const ja = Buffer.from("日本\n");
    child.stdout.write(ja.subarray(0, 4));
    child.stdout.write(ja.subarray(4));
    child.stdout.write("line 1\r\nli");
    child.stdout.write("ne 2\n");
    child.stderr.write("\u001b[31;1mWrite-Error: \u001b[31;1mだめ\u001b[0m\r\n");
    child.stdout.write("tail");
    await flush();
    advance(1500);
    child.close(3);
    await done;

    expect(printed).toEqual(["$ git status", "日本", "line 1", "line 2", "Write-Error: だめ", "tail", "exit 3 (1.5s)"]);
    expect(runner.running).toBe(0);
  });

  it("実際の PowerShell で、構文エラーを化けずに出し、native command の終了コードを返す", async () => {
    const run = async (command: string) => {
      const printed: string[] = [];
      const runner = createCommandRunner({ cwd: process.cwd(), print: line => printed.push(line) });
      return { result: await runner.run(command), output: printed.join("\n") };
    };
    const parseError = await run("! git push");
    expect(parseError.result.code).toBe(1);
    expect(parseError.output).toContain("! git push");
    expect(parseError.output).not.toContain("�");
    expect((await run("cmd /c exit 3")).result.code).toBe(3);
  });

  it("pwsh が無ければ powershell で実行し、以後も powershell を使う", async () => {
    const { runner, printed, spawned, processes } = setup(["pwsh"]);
    const first = runner.run("dir");
    await flush();
    processes[0]!.close(0);
    await first;
    const second = runner.run("dir");
    processes[1]!.close(0);
    await second;
    expect(spawned.map(s => s.file)).toEqual(["pwsh", "powershell", "powershell"]);
    expect(printed.filter(line => line.startsWith("exit"))).toHaveLength(2);
  });

  it("同時に実行した command がどちらも pwsh で失敗しても、それぞれ powershell で実行する", async () => {
    const { runner, spawned, processes } = setup(["pwsh"]);
    const both = [runner.run("a"), runner.run("b")];
    await flush();
    processes.forEach(child => child.close(0));
    await Promise.all(both);
    expect(spawned.map(s => s.file)).toEqual(["pwsh", "pwsh", "powershell", "powershell"]);
  });

  it("シェルを起動できなければ error を表示する", async () => {
    const { runner, printed } = setup(["pwsh", "powershell"]);
    await runner.run("dir");
    expect(printed).toEqual(["$ dir", "error: spawn powershell ENOENT"]);
    expect(runner.running).toBe(0);
  });

  it("stopAll は実行中の command をプロセスツリーごと止め、止めた数を返す", async () => {
    const { runner, printed, processes, killed } = setup();
    const done = runner.run("pnpm dev");
    expect(runner.stopAll()).toBe(1);
    expect(killed).toEqual([101]);
    processes[0]!.close(1);
    await done;
    expect(printed.at(-1)).toMatch(/^stopped \(/);
    expect(runner.stopAll()).toBe(0);
  });

  it("idle は実行中の command がすべて終わってから resolve する", async () => {
    const { runner, processes } = setup();
    void runner.run("first");
    void runner.run("second");
    let idle = false;
    void runner.idle().then(() => {
      idle = true;
    });
    processes[0]!.close(0);
    await flush();
    await flush();
    expect(idle).toBe(false);
    processes[1]!.close(0);
    await flush();
    await flush();
    expect(idle).toBe(true);
  });
});
