import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AgentSettingsStore } from "../project/agent-settings.js";
import { writeFileAtomic } from "../project/atomic-write.js";
import { ConversationHistory } from "../project/conversation-history.js";

export function resetSandboxSettings(home: string): void {
  const directory = join(home, ".clodex", "state");
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory).filter(file => file.endsWith(".settings.json"))) {
    const settings = new AgentSettingsStore(join(directory, name));
    if (!settings.load().sandbox) continue;
    settings.setSandbox(false);
    const history = new ConversationHistory(join(directory, name.replace(/\.settings\.json$/, ".json")), { resumeLatest: true });
    history.clearAllSessions();
    writeFileAtomic(
      join(directory, name.replace(/\.settings\.json$/, ".recovery.json")),
      `${JSON.stringify({ current: history.currentId, conversations: {} })}\n`,
    );
  }
}
