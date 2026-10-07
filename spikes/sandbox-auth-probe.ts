import { homedir } from "node:os";
import { WindowsSandboxPlatform } from "../src/sandbox/windows-platform.js";
import { inspectSandboxAuthentication } from "../src/sandbox/authentication.js";

const platform = new WindowsSandboxPlatform(homedir(), "E:\\dev\\clodex-hybrid-test");
try {
  if (!await platform.inspect()) throw new Error("セットアップ未完了");
  await platform.connect(false);
  const broker = platform["broker"], profile = platform["identity"]?.profile;
  if (!broker || !profile) throw new Error("broker 未接続");
  console.log("authentication", JSON.stringify(await inspectSandboxAuthentication(broker,profile)));
  console.log("authenticate", await platform.authenticate());
  console.log("setupStatus", JSON.stringify(await platform.setupStatus()));
} finally { await platform.close(); }
