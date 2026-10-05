import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { EXIT_CODE_SUFFIX, UTF8_PREFIX, createCommandRunner, type CommandProcess } from "./command-runner.js";

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

const flush = () => new Promise((resolve) => setImmediate(resolve));

const setup = (missing: string[] = []) => {
  const printed: string[] = [];
  const spawned: Array<{ file: string; args: string[]; cwd: string }> = [];
  const processes: FakeProcess[] = [];
  const killed: number[] = [];
  let time = 0;
  const runner = createCommandRunner({
    cwd: "C:\\app",
    print: (line) => printed.push(line),
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
    killTree: (pid) => killed.push(pid),
    now: () => time,
  });
  return { runner, printed, spawned, processes, killed, advance: (ms: number) => { time += ms; } };
};

describe("createCommandRunner", () => {
  it("project root で pwsh を UTF-8 指定付きで起動し、出力を行ごとに表示して終了コードを出す", async () => {
    const { runner, printed, spawned, processes, advance } = setup();
    const done = runner.run("git status");
    expect(spawned).toEqual([{ file: "pwsh", args: ["-NoProfile", "-NonInteractive", "-Command", `${UTF8_PREFIX}git status${EXIT_CODE_SUFFIX}`], cwd: "C:\\app" }]);
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

  it("pwsh が無ければ powershell で実行し、以後も powershell を使う", async () => {
    const { runner, printed, spawned, processes } = setup(["pwsh"]);
    const first = runner.run("dir");
    await flush();
    processes[0]!.close(0);
    await first;
    const second = runner.run("dir");
    processes[1]!.close(0);
    await second;
    expect(spawned.map((s) => s.file)).toEqual(["pwsh", "powershell", "powershell"]);
    expect(printed.filter((line) => line.startsWith("exit"))).toHaveLength(2);
  });

  it("同時に実行した command がどちらも pwsh で失敗しても、それぞれ powershell で実行する", async () => {
    const { runner, spawned, processes } = setup(["pwsh"]);
    const both = [runner.run("a"), runner.run("b")];
    await flush();
    processes.forEach((child) => child.close(0));
    await Promise.all(both);
    expect(spawned.map((s) => s.file)).toEqual(["pwsh", "pwsh", "powershell", "powershell"]);
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
});
