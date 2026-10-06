import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runHost } from "./powershell.js";
import { connectBroker } from "./broker.js";
import { normalizeSandboxPath, WindowsSandboxPlatform } from "./windows-platform.js";

vi.mock("./powershell.js", async (original) => ({ ...await original<typeof import("./powershell.js")>(), runHost: vi.fn() }));
vi.mock("./broker.js", async (original) => ({ ...await original<typeof import("./broker.js")>(), connectBroker: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

it("safe.directory の大文字小文字・区切り・末尾を正規化する", () => {
  expect(normalizeSandboxPath("e:/Dev/Project/")).toBe(normalizeSandboxPath("E:\\dev\\project"));
});

it("消えた worktree の grant は OS の ACL 操作を行わない", async () => {
  const root = await mkdtemp(join(tmpdir(), "clodex-missing-"));
  const platform = new WindowsSandboxPlatform("C:\\Users\\human", root);
  await platform.grant(join(root,"missing"), true);
  expect(runHost).not.toHaveBeenCalled();
});

it("off の再実行で消えた worktree の safe.directory と lease を解除する", async () => {
  const home = await mkdtemp(join(tmpdir(), "clodex-lease-"));
  const project = join(home, "missing");
  await mkdir(join(home, ".clodex"));
  await writeFile(join(home, ".clodex", "agent-credential"), "fixture");
  const journal = join(home, ".clodex", `sandbox-project-${createHash("sha256").update(project.toLowerCase()).digest("hex").slice(0,16)}.json`);
  const acl = { sddl: "D:", rules: [] };
  await writeFile(journal, JSON.stringify({sid:"agent",leases:[{path:project,before:acl,after:acl,gitHuman:true,gitAgent:true}]}));
  const directory = project.toUpperCase().replaceAll("\\", "/") + "/";
  vi.mocked(runHost).mockImplementation(async script => {
    if(script.includes("Get-LocalUser"))return JSON.stringify({humanSid:"human",agentSid:"agent",profile:"C:\\Users\\agent",machine:{}});
    if(script.includes("--get-all"))return directory;
    return "";
  });
  const run = vi.fn(async (_command: string,args: string[]) => args.includes("--get-all") ? directory : "");
  const close = vi.fn(async () => {});
  vi.mocked(connectBroker).mockResolvedValue({run,close,spawn:vi.fn()});
  const platform = new WindowsSandboxPlatform(home,project);
  vi.spyOn(platform,"connect").mockImplementation(async () => {
    // 実行環境の作成を避け、接続先だけを差し替える。
    Object.defineProperty(platform,"broker",{value:{run,close,spawn:vi.fn()},writable:true});
  });
  await platform.release();
  expect(run).toHaveBeenCalledWith("git",["config","--global","--fixed-value","--unset-all","safe.directory",directory],"C:\\Users\\agent");
  expect(vi.mocked(runHost).mock.calls.some(([script])=>script.includes("--unset-all"))).toBe(true);
  expect(JSON.parse(await readFile(journal,"utf8"))).toMatchObject({leases:[]});
});
