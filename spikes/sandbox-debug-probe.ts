// /sandbox on の失敗箇所を切り分ける。管理者処理とログインの手前（状態の検査と broker への接続）だけを実行する
import { homedir } from "node:os";
import { WindowsSandboxPlatform } from "../src/sandbox/windows-platform.js";
const project = process.argv.slice(2).find(arg => !arg.startsWith("--")) ?? "E:\\dev\\clodex-hybrid-test";
const platform = new WindowsSandboxPlatform(homedir(), project, (text) => console.log("notice:", text));
const step = async (name: string, run: () => Promise<unknown>) => {
  try { console.log(name, "=>", JSON.stringify(await run())); }
  catch (error) { process.exitCode = 1; console.log(name, "ERR", error instanceof Error ? error.stack : error); }
};
await step("inspect", () => platform.inspect());
await step("connect(false)", () => platform.connect(false));
await step("setupStatus", () => platform.setupStatus());
// --install: CLI のインストールと同じ処理を、出力を捨てずに実行する
if (process.argv.includes("--install")) {
  await step("install", async () => platform.installCli(await platform.setupStatus()));
  await step("setupStatus after install", () => platform.setupStatus());
}
await step("close", () => platform.close());
