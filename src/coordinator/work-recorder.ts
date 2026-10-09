import type { AgentEvent, AgentId } from "../agents/agent-adapter.js";
import type { ConversationRecovery } from "../project/recovery-store.js";
import type { PendingQuestion } from "../protocol/questions.js";

const LAST_ACTIONS_LIMIT = 5;
type TurnWork = { plan?: string; actions: string[]; files: Set<string> };

export class WorkRecorder {
  private readonly turnWork: Partial<Record<AgentId, TurnWork>> = {};

  record(id: AgentId, event: AgentEvent): readonly string[] {
    if (event.type === "turn_started") this.turnWork[id] = { actions: [], files: new Set() };
    if (event.type === "text") {
      const work = this.turnWork[id];
      if (work) work.plan ??= event.text.split(/\r?\n/, 1)[0];
    }
    if (event.type !== "tool") return [];
    const work = this.turnWork[id];
    if (work) {
      work.actions.push(`${event.name} ${event.input}`.trim());
      if (work.actions.length > LAST_ACTIONS_LIMIT) work.actions.shift();
    }
    for (const file of event.files ?? []) work?.files.add(file);
    return event.files ?? [];
  }

  lastWork(id: AgentId): TurnWork | undefined {
    return this.turnWork[id];
  }

  recoveryState(questions: PendingQuestion[], interrupted: AgentId[], queue: ConversationRecovery["queue"]): ConversationRecovery {
    const lastWork: NonNullable<ConversationRecovery["lastWork"]> = {};
    for (const id of interrupted) {
      const work = this.turnWork[id];
      if (work && (work.plan || work.actions.length)) lastWork[id] = { ...(work.plan ? { plan: work.plan } : {}), actions: [...work.actions] };
    }
    return { questions, interrupted, queue, ...(Object.keys(lastWork).length ? { lastWork } : {}) };
  }

  recoveryWorkNote(work: NonNullable<ConversationRecovery["lastWork"]>[AgentId]): string {
    if (!work) return "";
    const plan = work.plan ? `Before the restart you were: ${work.plan}.` : "";
    const actions = work.actions.length ? `Last actions:\n${work.actions.map(action => `- ${action}`).join("\n")}` : "";
    return `\n${[plan, actions].filter(Boolean).join(" ")}`;
  }
}
