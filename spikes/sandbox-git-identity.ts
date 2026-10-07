import { homedir } from "node:os";
import { WindowsSandboxPlatform } from "../src/sandbox/windows-platform.js";

const platform=new WindowsSandboxPlatform(homedir(),"E:\\dev\\clodex-hybrid-test");
try {
  if(!await platform.inspect())throw new Error("セットアップ未完了");
  await platform.connect(false);
  await platform["syncGitIdentity"]();
  console.log("Git 作者設定を同期済み");
} finally {await platform.close();}
