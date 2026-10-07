// /sandbox on の失敗箇所を切り分ける。管理者処理とログインの手前（状態の検査と broker への接続）だけを実行する
import { homedir } from "node:os";
import { WindowsSandboxPlatform } from "../src/sandbox/windows-platform.js";

const project = process.argv[2] ?? "E:\\dev\\clodex-hybrid-test";
const platform = new WindowsSandboxPlatform(homedir(), project, (text) => console.log("notice:", text));
const step = async (name: string, run: () => Promise<unknown>) => {
  try { console.log(name, "=>", JSON.stringify(await run())); }
  catch (error) { console.log(name, "ERR", error instanceof Error ? error.stack : error); }
};
await step("inspect", () => platform.inspect());
await step("connect(false)", () => platform.connect(false));
await step("setupStatus", () => platform.setupStatus());
await step("close", () => platform.close());
