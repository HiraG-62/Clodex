// sandbox の中（clodex-agent の restricted token）で任意のコマンドを 1 回実行し、出力を表示する
import { homedir } from "node:os";
import { WindowsSandboxPlatform } from "../src/sandbox/windows-platform.js";

const [project = "E:\\dev\\clodex-hybrid-test", command = "node", ...args] = process.argv.slice(2);
const platform = new WindowsSandboxPlatform(homedir(), project);
try {
  if (!await platform.inspect()) throw new Error("セットアップ未完了");
  await platform.connect(false);
  const broker = platform["broker"];
  const profile = platform["identity"]?.profile;
  if (!broker || !profile) throw new Error("broker 未接続");
  console.log(await broker.run(command, args, profile));
} catch (error) {
  process.exitCode = 1;
  console.log(error instanceof Error ? error.message : error);
} finally {
  await platform.close();
}
