import { AGENT_META } from "../../agents/agent-meta.js";
import type { CoordinatorEvent } from "../../coordinator/event-bus.js";
import type { MessageKey } from "../../i18n/messages.js";

type Progress = Pick<Extract<CoordinatorEvent, { kind: "brainstorm" }>, "phase" | "round" | "total" | "advocate" | "reason">;
type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

export const brainstormHeading = (event: Progress, t: Translate): string => {
  if (event.phase === "opening") return t("web.brainstorm.opening");
  if (event.phase === "human") return t("web.brainstorm.human");
  if (event.phase === "summary") {
    const reason = event.reason === "human" ? "humanReason" : event.reason;
    return t("web.brainstorm.summary") + (reason ? ` · ${t(`web.brainstorm.${reason}`)}` : "");
  }
  return t("web.brainstorm.round", { round: event.round ?? 1, total: event.total, advocate: event.advocate ? AGENT_META[event.advocate].name : "—" });
};
