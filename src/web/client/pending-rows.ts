import type { AgentId } from "../../agents/agent-adapter.js";
import type { PendingMessage } from "../../coordinator/coordinator.js";

export type PendingRow = {
  kind: "input" | "message";
  id: string;
  agent: AgentId;
  text: string;
  holdTime?: string;
  from?: AgentId;
  type?: PendingMessage["type"];
};

export function pendingRows(
  inputs: readonly { id: string; agent: AgentId; text: string }[],
  messages: readonly PendingMessage[],
  agents: readonly { id: AgentId; holdUntil?: string }[],
  referencesSeparator: string,
  now: Date = new Date(),
): PendingRow[] {
  const holdTime = (agent: AgentId): string | undefined => {
    const iso = agents.find((item) => item.id === agent)?.holdUntil;
    if (!iso) return undefined;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return undefined;
    const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    return date.toDateString() === now.toDateString() ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
  };
  return [
    ...inputs.map((input): PendingRow => ({ kind: "input", id: input.id, agent: input.agent,
      text: input.text.split(referencesSeparator)[0] ?? input.text, holdTime: holdTime(input.agent) })),
    ...messages.map((message): PendingRow => ({ kind: "message", id: message.id, agent: message.agent,
      from: message.from, type: message.type, text: message.text.split(/\r?\n/, 1)[0] ?? "",
      holdTime: holdTime(message.agent) })),
  ];
}
