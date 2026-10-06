import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WindowsSandboxPlatform } from "../src/sandbox/windows-platform.js";

const project = "E:\\dev\\clodex-hybrid-test";
const platform = new WindowsSandboxPlatform(homedir(), project, console.log);
await mkdir(project, { recursive: true });
async function run(command: string, args: string[]): Promise<string> {
  const proc = platform.spawn(command, args, { cwd: project, env: {} });
  return new Promise((resolve, reject) => {
    const output: string[] = [];
    const timeout = setTimeout(() => { proc.kill(); reject(new Error("タイムアウト")); }, 30_000);
    proc.onLine((line) => output.push(line));
    proc.onExit((code) => { clearTimeout(timeout); if (code === 0) resolve(output.join("\n")); else reject(new Error(`終了コード ${code}: ${output.join("\n")}`)); });
    proc.spawned.catch((error: unknown) => { clearTimeout(timeout); reject(error); });
  });
}
try {
  if (!await platform.inspect()) throw new Error("セットアップ未完了");
  await platform.connect();
  await platform.grant(project, true);
  console.log(await run("__inspect", []));
  for (const cli of ["claude", "codex"]) console.log(`${cli}: ${await run(cli, ["--version"])}`);
  const leaf = `clodex-product-${randomUUID()}.txt`;
  const paths = [join(project, leaf), join("E:\\", leaf)];
  console.log(await run("node", ["-e", `const fs=require('node:fs');for(const p of ${JSON.stringify(paths)}){try{fs.writeFileSync(p,'probe',{flag:'wx'});fs.unlinkSync(p);console.log(p+': 許可')}catch(e){console.log(p+': '+e.code)}}`]));
} finally {
  try { await platform.release(); } finally { await platform.close(); }
}
