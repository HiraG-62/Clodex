// Agent 間 message の hard limit を chain 単位で強制する（DESIGN.md §14）
import type { AgentMessage, MessageType } from "../protocol/messages.js";

export interface BudgetLimits {
  maxMessagesPerChain: number;
  maxReviewRoundsPerChain: number;
  maxDelegationsPerChain: number;
  maxDelegationDepth: number;
}

export const DEFAULT_LIMITS: BudgetLimits = {
  maxMessagesPerChain: 4,
  maxReviewRoundsPerChain: 2,
  maxDelegationsPerChain: 2,
  maxDelegationDepth: 2,
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

const limitError = (name: keyof BudgetLimits, limit: number) =>
  `Budget limit reached: ${name} (${limit}). Do not send more messages for this chain; ` +
  "report the current status to the human instead.";

export class BudgetManager {
  private readonly meta = new Map<string, MessageMeta>();
  private readonly chains = new Map<string, ChainUsage>();

  constructor(private readonly limits: BudgetLimits = DEFAULT_LIMITS) {}

  // parent: 送信元 Agent が処理中の message（人間の入力によるターンなら undefined）
  // 上限内なら記録して undefined、超えるならエラー文を返す（記録しない）
  admit(message: AgentMessage, parent: AgentMessage | undefined): string | undefined {
    if (message.type === "ACK") return undefined;

    const parentMeta = parent ? this.meta.get(parent.id) : undefined;
    const chainId = parentMeta?.chainId ?? message.id;
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
