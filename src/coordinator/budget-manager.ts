// Agent 間 message の hard limit を chain 単位で強制する（DESIGN.md §14）
import type { AgentMessage, MessageType } from "../protocol/messages.js";

export interface BudgetLimits {
  maxMessagesPerChain: number;
  maxReviewRoundsPerChain: number;
  maxDelegationsPerChain: number;
  maxDelegationDepth: number;
}

// 分業の流れ（設計 → 実装の委譲 → レビュー → 修正の委譲）が上限に当たらない値（DESIGN.md §14 v0.2）
export const DEFAULT_LIMITS: BudgetLimits = {
  maxMessagesPerChain: 8,
  maxReviewRoundsPerChain: 3,
  maxDelegationsPerChain: 4,
  maxDelegationDepth: 2,
};

// /limits unlimited（DESIGN.md §14）
export const UNLIMITED_LIMITS: BudgetLimits = {
  maxMessagesPerChain: Infinity,
  maxReviewRoundsPerChain: Infinity,
  maxDelegationsPerChain: Infinity,
  maxDelegationDepth: Infinity,
};

export const LIMIT_KEYS = {
  messages: "maxMessagesPerChain",
  reviews: "maxReviewRoundsPerChain",
  delegations: "maxDelegationsPerChain",
  depth: "maxDelegationDepth",
} as const satisfies Record<string, keyof BudgetLimits>;
export type LimitName = keyof typeof LIMIT_KEYS;
export const LIMIT_NAMES = Object.keys(LIMIT_KEYS) as LimitName[];
export const LIMIT_MIN = 1;
export const LIMIT_MAX = 100;
export const isLimitValue = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= LIMIT_MIN && value <= LIMIT_MAX;
export const humanBudgetError = (error: string): string => {
  const name = LIMIT_NAMES.find((name) => error.startsWith(`Budget limit reached: ${LIMIT_KEYS[name]} (`));
  return name ? `${error} (/limits ${name} <n>)` : error;
};

const REQUEST_TYPES = new Set<MessageType>(["QUESTION", "REVIEW_REQUEST", "DELEGATE"]);
const DELEGATION_TYPES = new Set<MessageType>(["QUESTION", "DELEGATE"]);

interface ChainUsage {
  messages: number;
  reviewRounds: number;
  delegations: number;
}

interface MessageMeta {
  chainId: string;
  depth: number;
}

const EMPTY_USAGE: ChainUsage = { messages: 0, reviewRounds: 0, delegations: 0 };

const STOPPED_ERROR = "This exchange was stopped by the human (/interrupt). Do not send more messages for it; " +
  "report the current status to the human instead.";

const limitError = (name: keyof BudgetLimits, limit: number) =>
  `Budget limit reached: ${name} (${limit}). Do not send more messages for this chain; ` +
  "report the current status to the human instead.";

export class BudgetManager {
  private readonly meta = new Map<string, MessageMeta>();
  private readonly chains = new Map<string, ChainUsage>();
  // /interrupt で人が止めたやり取り（DESIGN.md §28 v0.3 A）
  private readonly closed = new Set<string>();

  constructor(private limits: BudgetLimits = DEFAULT_LIMITS) {}

  setLimits(limits: BudgetLimits): void {
    this.limits = { ...limits };
  }

  restore(message: AgentMessage): void {
    if (message.type === "ACK") return;
    this.meta.set(message.id, { chainId: message.id, depth: 1 });
    this.chains.set(message.id, {
      messages: 1,
      reviewRounds: message.type === "REVIEW_REQUEST" ? 1 : 0,
      delegations: DELEGATION_TYPES.has(message.type) ? 1 : 0,
    });
  }

  // parent: 送信元 Agent が処理中の message（人間の入力によるターンなら undefined）
  // 上限内なら記録して undefined、超えるならエラー文を返す（記録しない）
  admit(message: AgentMessage, parent: AgentMessage | undefined): string | undefined {
    if (message.type === "ACK") return undefined;

    const parentMeta = parent ? this.meta.get(parent.id) : undefined;
    const chainId = parentMeta?.chainId ?? message.id;
    if (this.closed.has(chainId)) return STOPPED_ERROR;
    const depth = this.depthOf(message, parent, parentMeta);
    const usage = this.chains.get(chainId) ?? EMPTY_USAGE;
    const next: ChainUsage = {
      messages: usage.messages + 1,
      reviewRounds: usage.reviewRounds + (message.type === "REVIEW_REQUEST" ? 1 : 0),
      delegations: usage.delegations + (DELEGATION_TYPES.has(message.type) ? 1 : 0),
    };

    const error = this.exceeded(next, depth);
    if (error) return error;
    this.meta.set(message.id, { chainId, depth });
    this.chains.set(chainId, next);
    return undefined;
  }

  // messages が属する chain を閉じ、以後その chain の送信を拒否する
  closeChains(messages: readonly AgentMessage[]): void {
    for (const message of messages) {
      const chainId = this.meta.get(message.id)?.chainId;
      if (chainId) this.closed.add(chainId);
    }
  }

  // 依頼を処理中に送った依頼だけ深くなる。結果を処理中の依頼は同じ階層での継続（DESIGN.md §14）
  private depthOf(message: AgentMessage, parent: AgentMessage | undefined, parentMeta: MessageMeta | undefined): number {
    if (!parent || !parentMeta) return 1;
    const nested = REQUEST_TYPES.has(message.type) && REQUEST_TYPES.has(parent.type);
    return nested ? parentMeta.depth + 1 : parentMeta.depth;
  }

  private exceeded(usage: ChainUsage, depth: number): string | undefined {
    const { maxMessagesPerChain, maxReviewRoundsPerChain, maxDelegationsPerChain, maxDelegationDepth } = this.limits;
    if (usage.messages > maxMessagesPerChain) return limitError("maxMessagesPerChain", maxMessagesPerChain);
    if (usage.reviewRounds > maxReviewRoundsPerChain) return limitError("maxReviewRoundsPerChain", maxReviewRoundsPerChain);
    if (usage.delegations > maxDelegationsPerChain) return limitError("maxDelegationsPerChain", maxDelegationsPerChain);
    if (depth > maxDelegationDepth) return limitError("maxDelegationDepth", maxDelegationDepth);
    return undefined;
  }
}
