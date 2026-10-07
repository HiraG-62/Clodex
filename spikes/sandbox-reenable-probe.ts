import { homedir } from "node:os";
import { openProject } from "../src/hub/project-context.js";
import { EMPTY_MODEL_CATALOG } from "../src/agents/startup-probe.js";
import { WindowsSandboxPlatform } from "../src/sandbox/windows-platform.js";

class ProbeSandboxPlatform extends WindowsSandboxPlatform {
  override async setup(): Promise<void> {
    if (!await this.ready()) throw new Error("未ログイン: この probe ではセットアップを実行しない");
  }
}

let failures = 0;
for (const event of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(event, (error: unknown) => {
    failures++;
    console.error(event, error instanceof Error ? error.stack : error);
  });
}
const context = await openProject({
  projectRoot: "E:\\dev\\clodex-hybrid-test", homeDir: homedir(),
  sandboxPlatform: new ProbeSandboxPlatform(homedir(), "E:\\dev\\clodex-hybrid-test"),
  args: { models: {}, resume: false, serve: false, web: false }, language: "ja",
  notify: text => console.log("notice", text), printTerminal: console.log,
  displayMode: () => "verbose", isCurrent: () => true,
  modelCatalog: EMPTY_MODEL_CATALOG, registerCoordinator: () => () => {},
});
const initial = context.sandbox.enabled;
try {
  for (const enabled of [false, true, false, true]) {
    console.log("sandbox", enabled, new Date().toISOString());
    try { await context.sandbox.setEnabled(enabled); }
    catch (error) { console.error("command error", error instanceof Error ? error.stack : error); }
    console.log("status", JSON.stringify(context.workspace.current.coordinator.status().map(({id,status})=>({id,status}))));
  }
} finally {
  if (context.sandbox.enabled && !initial) await context.sandbox.setEnabled(false);
  context.settingsStore.setSandbox(initial);
  await context.close();
}
console.log("unhandled", failures);
if (failures) process.exitCode = 1;
