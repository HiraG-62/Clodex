import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { WindowsSandboxPlatform } from "../src/sandbox/windows-platform.js";
import { psQuote, runHost } from "../src/sandbox/powershell.js";

const root = await mkdtemp("E:\\dev\\clodex-hybrid-test\\git-guard-");
const main = join(root, "main"), work = join(root, "work");
await mkdir(main);
await runHost(`& git init ${psQuote(main)};& git -C ${psQuote(main)} -c user.name=ClodexSpike -c user.email=spike@example.invalid -c commit.gpgsign=false -c core.hooksPath=${psQuote(join(root,"empty"))} commit --allow-empty -m probe;& git -C ${psQuote(main)} worktree add -b probe ${psQuote(work)};if($LASTEXITCODE){throw 'git fixture'}`);
const config = await readFile(join(main,".git","config"),"utf8");
const platform = new WindowsSandboxPlatform(homedir(),main,console.log);
async function run(script: string) {
  const child=platform.spawn("node",["-e",script],{cwd:main,env:{}});
  await new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(new Error("タイムアウト"));},30_000);
    child.onLine(console.log);child.onExit(code=>{clearTimeout(timer);if(code===0)resolve();else reject(new Error(`終了 ${code}`));});
    child.spawned.catch(reject);
  });
}
try {
  if(!await platform.inspect())throw new Error("セットアップ未完了");
  await platform.connect(false);
  await platform.grant(main,true);await platform.grant(work,true);
  await run(`const f=require('fs');for(const path of ${JSON.stringify([join(main,".git","config"),join(main,".git","config.worktree"),join(main,".git","hooks","pre-commit"),join(work,".git")])}){try{f.appendFileSync(path,'probe');console.log(path+': 書込成功')}catch(e){console.log(path+': '+e.code)}}try{f.renameSync(${JSON.stringify(join(main,".git"))},${JSON.stringify(join(main,".git-moved"))});console.log('.git rename 成功')}catch(e){console.log('.git rename: '+e.code)}`);
  await run(`const r=require('child_process').spawnSync('git',['-c','user.name=ClodexSpike','-c','user.email=spike@example.invalid','-c','commit.gpgsign=false','commit','--allow-empty','-m','restricted'],{encoding:'utf8'});console.log(JSON.stringify({code:r.status,out:r.stdout,error:r.stderr}))`);
} finally {try{await platform.release();}finally{await platform.close();}}
console.log(`config 復元: ${config===await readFile(join(main,".git","config"),"utf8")}`);
