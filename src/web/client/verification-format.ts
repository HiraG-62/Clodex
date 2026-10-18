import type { t } from "../../i18n/i18n.js";
import type { AgentMessage } from "../../protocol/messages.js";

export interface VerificationLine {
  text: string;
  warning: boolean;
}
export const formatVerification = (message: AgentMessage, translate: typeof t) => {
  const evidence = message.evidence;
  const checks: VerificationLine[] = (evidence?.checks ?? []).map(check => ({
    text: `${check.command}: ${!check.ran ? translate("verification.notRun") : check.exitCode !== undefined ? `exit ${check.exitCode}` : translate(check.failed ? "verification.failed" : "verification.unknown")}`,
    warning: check.exitCode !== undefined ? check.exitCode !== 0 : check.failed === true,
  }));
  const changed = evidence?.changed;
  const files: VerificationLine[] = Array.isArray(changed)
    ? changed.length
      ? changed.map(file => ({
          text: `${file.path}${file.scope ? ` [${file.scope}]` : ""}${file.peer ? ` (${translate("verification.peer", { agent: message.to })})` : ""}`,
          warning: file.scope === "outside" || file.scope === "forbidden",
        }))
      : [{ text: translate("verification.none"), warning: false }]
    : [];
  const check = message.specCheck;
  return {
    checks,
    files,
    ...(evidence ? { root: evidence.root } : {}),
    ...(changed ? { changed: translate("verification.changed", { count: Array.isArray(changed) ? changed.length : changed.count }) } : {}),
    ...(check
      ? {
          specCheck: {
            text: `${translate("verification.specCheck")} · ${check.command}: ${check.timedOut ? translate("verification.timeout") : check.exitCode !== undefined ? `exit ${check.exitCode}` : translate("verification.failed")}`,
            warning: check.timedOut === true || check.exitCode !== 0,
            output: check.output,
          },
        }
      : {}),
  };
};
