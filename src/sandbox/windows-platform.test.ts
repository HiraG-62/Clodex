import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runHost } from "./powershell.js";
import { connectBroker } from "./broker.js";
import { normalizeSandboxPath, WindowsSandboxPlatform } from "./windows-platform.js";
import { WindowsAccountSetup } from "./account-setup.js";

vi.mock("./powershell.js", async (original) => ({ ...await original<typeof import("./powershell.js")>(), runHost: vi.fn() }));
vi.mock("./broker.js", async (original) => ({ ...await original<typeof import("./broker.js")>(), connectBroker: vi.fn() }));
afterEach(() => {vi.restoreAllMocks();vi.unstubAllEnvs();});

it("Git 作者の空白・日本語・引用符を broker の1引数で保存する",async()=>{
  const platform=new WindowsSandboxPlatform("human","project");
  const run=vi.fn().mockResolvedValue("");
  Object.defineProperty(platform,"broker",{value:{run}});
  Object.defineProperty(platform,"identity",{value:{profile:"agent-profile"}});
  const name=' 山田 太郎 "開発" O\'Brien ';
  vi.mocked(runHost).mockResolvedValueOnce(JSON.stringify(name)).mockResolvedValueOnce(JSON.stringify("dev@example.invalid"));
  await platform["syncGitIdentity"]();
  expect(run.mock.calls).toEqual([
    ["git",["config","--global","--replace-all","user.name",name],"agent-profile"],
    ["git",["config","--global","--replace-all","user.email","dev@example.invalid"],"agent-profile"],
  ]);
});

it("人の Git 作者設定がなければ agent の既存設定を消さない",async()=>{
  const platform=new WindowsSandboxPlatform("human","project");
  const run=vi.fn();Object.defineProperty(platform,"broker",{value:{run}});
  vi.mocked(runHost).mockResolvedValue("null");
  await platform["syncGitIdentity"]();
  expect(run).not.toHaveBeenCalled();
});

it("Git 作者の取得失敗を未設定扱いにしない",async()=>{
  const platform=new WindowsSandboxPlatform("human","project");
  vi.mocked(runHost).mockRejectedValueOnce(new Error("git failed"));
  await expect(platform["syncGitIdentity"]()).rejects.toThrow("git failed");
});

it("保存済み authenticated=true に依存せず毎回認証を検査する", async () => {
  const home = await mkdtemp(join(tmpdir(), "clodex-auth-status-"));
  await mkdir(join(home,".clodex"));
  await writeFile(join(home,".clodex","sandbox-setup.json"), JSON.stringify({authenticated:true,agentSid:"agent"}));
  const platform = new WindowsSandboxPlatform(home,"project");
  vi.mocked(runHost).mockResolvedValue(JSON.stringify({user:true,credential:true}));
  vi.spyOn(platform,"inspect").mockResolvedValue(true);
  vi.spyOn(platform,"connect").mockResolvedValue();
  Object.defineProperty(platform,"identity",{value:{agentSid:"agent",profile:"profile"}});
  Object.defineProperty(platform,"broker",{value:{run:vi.fn(async()=>JSON.stringify({claude:true,codex:true,pnpm:true}))}});
  const authenticate = vi.spyOn(platform,"authenticate").mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  expect((await platform.setupStatus()).authenticated).toBe(false);
  expect((await platform.setupStatus()).authenticated).toBe(true);
  expect(authenticate).toHaveBeenCalledTimes(2);
});

it("不足した CLI をすべて agent の npm prefix にインストールする",async()=>{
  const platform=new WindowsSandboxPlatform("human","project");
  const run=vi.fn().mockResolvedValue("");
  Object.defineProperty(platform,"broker",{value:{run}});
  Object.defineProperty(platform,"identity",{value:{profile:"agent-profile"}});
  await platform.installCli({managed:true,user:true,credential:true,claude:false,codex:true,pnpm:true,authenticated:false});
  const args=run.mock.calls[0]![1] as string[];
  const script=Buffer.from(args.at(-1)!,"base64").toString("utf16le");
  expect(script).toContain("$env:NPM_CONFIG_PREFIX=Join-Path $env:APPDATA 'npm'");
  expect(script).toContain("npm.cmd install --global @anthropic-ai/claude-code @openai/codex pnpm");
  expect(script).not.toContain("Invoke-RestMethod");
  expect(run.mock.calls.slice(1).map(call=>call[0])).toEqual(["claude","codex","pnpm"]);
});

it("safe.directory の大文字小文字・区切り・末尾を正規化する", () => {
  expect(normalizeSandboxPath("e:/Dev/Project/")).toBe(normalizeSandboxPath("E:\\dev\\project"));
});

it("uninstall で runtime と全 journal を除去し、再作成後も繰り返せる", async()=>{
  const home=await mkdtemp(join(tmpdir(),"clodex-uninstall-"));await mkdir(join(home,".clodex"));
  await writeFile(join(home,".clodex","agent-credential"),"fixture");
  const programData=join(home,"program-data");vi.stubEnv("ProgramData",programData);
  const root=join(programData,"Clodex-Sandbox-human");
  vi.mocked(runHost).mockImplementation(async script=>script.includes("Get-LocalUser")?JSON.stringify({humanSid:"human",agentSid:"new-agent",profile:"C:\\Users\\agent",machine:{}}):"");
  const uninstall=vi.spyOn(WindowsAccountSetup.prototype,"uninstall").mockResolvedValue();
  const platform=new WindowsSandboxPlatform(home,join(home,"project"));vi.spyOn(platform,"connect").mockResolvedValue();
  for(let cycle=0;cycle<2;cycle++){
    await mkdir(join(root,"cache"),{recursive:true});await writeFile(join(root,"cache","node.exe"),"fixture");
    const journal=join(home,".clodex","sandbox-project-0000000000000000.json");
    await writeFile(journal,JSON.stringify({sid:"old-agent",leases:[]}));
    await platform.uninstall();
    await expect(readFile(journal)).rejects.toMatchObject({code:"ENOENT"});
    await expect(readFile(join(root,"cache","node.exe"))).rejects.toMatchObject({code:"ENOENT"});
    expect(await platform.inspect()).toBe(true);
  }
  expect(uninstall).toHaveBeenCalledTimes(2);
});

it("消えた worktree の grant は OS の ACL 操作を行わない", async () => {
  const root = await mkdtemp(join(tmpdir(), "clodex-missing-"));
  const platform = new WindowsSandboxPlatform("C:\\Users\\human", root);
  await platform.grant(join(root,"missing"), true);
  expect(runHost).not.toHaveBeenCalled();
});

it.each([false,true])("古い SID の ACE を解除して journal を再作成し、途中失敗なら記録を残す: %s", async fail => {
  const home=await mkdtemp(join(tmpdir(),"clodex-stale-sid-"));const project=join(home,"project");await mkdir(project);await mkdir(join(home,".clodex"));
  await writeFile(join(home,".clodex","agent-credential"),"fixture");
  const journal=join(home,".clodex",`sandbox-project-${createHash("sha256").update(project.toLowerCase()).digest("hex").slice(0,16)}.json`);
  const rule={rights:2032127,inheritance:0,propagation:0,type:0};
  const before={sddl:"D:",rules:[]};const after={sddl:"D:",rules:[rule,{...rule,human:true},{...rule,rights:131072,owner:true}]};
  await writeFile(journal,JSON.stringify({sid:"old-agent",leases:[{path:project,before,after,gitHuman:false,gitAgent:false}]}));
  vi.mocked(runHost).mockImplementation(async script=>{
    if(script.includes("Get-LocalUser"))return JSON.stringify({humanSid:"human",agentSid:"new-agent",profile:"C:\\Users\\agent",machine:{}});
    if(script.includes("Snapshot $acl"))return JSON.stringify(after);
    if(script.includes("SetAccessControl")&&fail)throw new Error("ACL failure");
    return "";
  });
  const platform=new WindowsSandboxPlatform(home,project);
  expect(await platform.inspect()).toBe(!fail);
  const saved=JSON.parse(await readFile(journal,"utf8"));
  if(fail)expect(saved).toMatchObject({sid:"old-agent",leases:[{path:project}]});
  else{
    expect(saved).toEqual({sid:"new-agent",leases:[]});
    const calls=vi.mocked(runHost).mock.calls.filter(([script])=>script.includes("SetAccessControl"));
    expect(calls).toHaveLength(1);expect(calls[0]?.[0]).toContain("old-agent");
    expect(await platform.inspect()).toBe(true);
    expect(vi.mocked(runHost).mock.calls.filter(([script])=>script.includes("SetAccessControl"))).toHaveLength(1);
  }
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
