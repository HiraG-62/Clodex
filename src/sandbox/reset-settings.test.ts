import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AgentSettingsStore, agentSettingsPath } from "../project/agent-settings.js";
import { ConversationHistory, conversationStatePath } from "../project/conversation-history.js";
import { resetSandboxSettings } from "./reset-settings.js";

it("未起動の project も off にし、permission と会話のタイトルを残す", () => {
  const home = mkdtempSync(join(tmpdir(), "clodex-uninstall-settings-"));
  const path = conversationStatePath(home, "E:\\project");
  const settings = new AgentSettingsStore(agentSettingsPath(path));
  settings.update(["claude"], { permission: "read-only" });
  settings.setSandbox(true);
  const history = new ConversationHistory(path, { resumeLatest: false });
  history.rename("残す会話");
  resetSandboxSettings(home);
  expect(settings.load()).toEqual({ sandbox: false, claude: { permission: "read-only" } });
  expect(new ConversationHistory(path, { resumeLatest: true }).current.title).toBe("残す会話");
});
