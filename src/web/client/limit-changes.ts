import type { LimitName } from "../../coordinator/budget-manager.js";

export interface LimitChange { name: LimitName; value: number }

export function limitChanges(current: Record<LimitName, number>, draft: Record<LimitName, string>): { changes: LimitChange[]; valid: boolean } {
  const names: LimitName[] = ["messages", "reviews", "delegations", "depth"];
  const min = 1;
  const max = 100;
  const changes: LimitChange[] = [];
  for (const name of names) {
    const raw = draft[name].trim();
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) return { changes: [], valid: false };
    if (value !== current[name]) changes.push({ name, value });
  }
  return { changes, valid: true };
}
