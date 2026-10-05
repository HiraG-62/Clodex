import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Hub } from "./hub.js";

const setup = () => {
  const homeDir = mkdtempSync(join(tmpdir(), "clodex-hub-"));
  const opened: string[] = [];
  const hub = new Hub({ homeDir, cwd: homeDir, openProject: async (projectRoot: string) => {
    opened.push(projectRoot);
    return { projectRoot, close: async () => {} };
  } });
  return { homeDir, hub, opened };
};

describe("Hub", () => {
  it("project を開いて切り替えても既存の context を保持する", async () => {
    const { homeDir, hub, opened } = setup();
    const first = await hub.open("one");
    await hub.open("two");
    expect(hub.lastProject).toBe(resolve(homeDir, "two"));
    expect(hub.current?.projectRoot).toBe(resolve(opened[1]!));
    expect(hub.list().filter((project) => project.open)).toHaveLength(2);
    expect(await hub.open("one")).toBe(first);
    expect(opened).toHaveLength(2);
  });

  it("開いた一覧と最後の project を保存し、次の起動では一覧だけ読む", async () => {
    const { homeDir, hub } = setup();
    await hub.open("one");
    await hub.open("two");
    const saved = JSON.parse(readFileSync(join(homeDir, ".clodex", "hub.json"), "utf8"));
    expect(saved.projects).toEqual([resolve(homeDir, "one"), resolve(homeDir, "two")]);
    expect(saved.lastProject).toBe(resolve(homeDir, "two"));
    const next = new Hub({ homeDir, cwd: homeDir, openProject: async (projectRoot: string) => ({ projectRoot, close: async () => {} }) });
    expect(next.current).toBeUndefined();
    expect(next.lastProject).toBe(resolve(homeDir, "two"));
    expect(next.list().every((project) => !project.open)).toBe(true);
  });
});
