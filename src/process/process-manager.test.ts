import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createProcessManager } from "./process-manager.js";

class FakeProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  constructor(readonly pid: number) {
    super();
  }
}

const flush = () => new Promise(resolve => setImmediate(resolve));

const setup = () => {
  const children: FakeProcess[] = [];
  const printed: string[] = [];
  const killed: number[] = [];
  const paths: string[] = [];
  let time = 0;
  let cwd = "C:/one";
  const manager = createProcessManager({
    cwd: () => cwd,
    print: line => printed.push(line),
    now: () => time,
    spawnShell: (_file, _args, path) => {
      paths.push(path);
      const child = new FakeProcess(children.length + 10);
      children.push(child);
      return child;
    },
    killTree: pid => killed.push(pid),
  });
  return {
    manager,
    children,
    printed,
    killed,
    paths,
    advance: () => {
      time = 1500;
      cwd = "C:/two";
    },
  };
};

describe("background process", () => {
  it("fallback 中に会話が変わっても起動時の cwd を保つ", () => {
    const paths: string[] = [];
    const children: FakeProcess[] = [];
    let cwd = "C:/one";
    const manager = createProcessManager({
      cwd: () => cwd,
      print: () => {},
      spawnShell: (_file, _args, path) => {
        paths.push(path);
        const child = new FakeProcess(children.length + 10);
        children.push(child);
        return child;
      },
    });
    manager.start("command");
    cwd = "C:/two";
    children[0]!.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }));
    children[0]!.emit("close", -1);
    expect(paths).toEqual(["C:/one", "C:/one"]);
    expect(manager.list()[0]?.status).toBe("running");
    children[1]!.emit("close", 0);
    expect(manager.list()[0]?.exitCode).toBe(0);
  });

  it("シェル起動失敗を記録して終了する", () => {
    const { manager, children, printed } = setup();
    manager.start("command");
    children[0]!.emit("error", new Error("failure"));
    children[0]!.emit("close", -1);
    expect(manager.output(1)).toEqual(["error: failure"]);
    expect(manager.list()[0]?.status).toBe("exited");
    expect(manager.kill(1)).toBe(false);
    expect(printed).toHaveLength(2);
  });
  it("番号を使い回さず起動時の cwd を使い、最後の 200 行を保持する", () => {
    const { manager, children, printed, paths, advance } = setup();
    expect(manager.start("first")).toBe(1);
    for (let i = 0; i < 205; i++) children[0]!.stdout.write(`${i}\n`);
    expect(manager.output(1)).toEqual(Array.from({ length: 200 }, (_, i) => String(i + 5)));
    expect(printed).toEqual(["#1 started: first"]);
    advance();
    children[0]!.emit("close", 3);
    expect(printed.at(-1)).toBe("#1 exit 3 (1.5s): first");
    expect(manager.list()[0]).toMatchObject({ id: 1, status: "exited", exitCode: 3, startedAt: 0, endedAt: 1500 });
    expect(manager.start("second")).toBe(2);
    expect(paths).toEqual(["C:/one", "C:/two"]);
    expect(manager.kill(1)).toBe(false);
    expect(manager.kill(99)).toBe(false);
    expect(manager.output(99)).toBeUndefined();
  });

  it("kill と stopAll でプロセスツリーを停止する", () => {
    const { manager, children, printed, killed, advance } = setup();
    manager.start("first");
    manager.start("second");
    expect(manager.kill(1)).toBe(true);
    expect(manager.kill(1)).toBe(false);
    manager.stopAll();
    expect(killed).toEqual([10, 11]);
    advance();
    children.forEach(child => child.emit("close", 1));
    expect(manager.list().map(({ status }) => status)).toEqual(["stopped", "stopped"]);
    expect(printed.slice(-2)).toEqual(["#1 stopped (1.5s): first", "#2 stopped (1.5s): second"]);
  });

  it("stopAll は止めたプロセスがすべて終わってから resolve する", async () => {
    const { manager, children } = setup();
    manager.start("first");
    manager.start("second");
    children[0]!.emit("close", 0);
    let stopped = false;
    void manager.stopAll().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    children[1]!.emit("close", 1);
    await flush();
    expect(stopped).toBe(true);
  });
});
