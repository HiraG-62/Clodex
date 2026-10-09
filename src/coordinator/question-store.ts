import { randomUUID } from "node:crypto";
import type { AgentId } from "../agents/agent-adapter.js";
import { t } from "../i18n/i18n.js";
import { type AskUserResult, answersSchema, askUserSchema, type PendingQuestion } from "../protocol/questions.js";

const QUESTION_ID_PREFIX = "q_";
const QUESTION_HEADER_LENGTH = 80;

export class QuestionStore {
  private readonly questions = new Map<string, PendingQuestion>();
  constructor(private readonly createId: () => string = randomUUID) {}

  ask(agent: AgentId, input: unknown): { result: AskUserResult; question?: PendingQuestion } {
    const parsed = askUserSchema.safeParse(input);
    if (!parsed.success) return { result: { ok: false, error: parsed.error.message } };
    const id = `${QUESTION_ID_PREFIX}${this.createId()}`;
    const question: PendingQuestion = { id, agent, questions: parsed.data.questions };
    this.questions.set(id, question);
    return { result: { ok: true, id }, question };
  }

  pending(): PendingQuestion[] {
    return [...this.questions.values()];
  }
  restore(questions: readonly PendingQuestion[]): void {
    for (const question of questions) this.questions.set(question.id, question);
  }

  answer(
    id: string,
    input: unknown,
  ):
    | { ok: false; error: string }
    | {
        ok: true;
        question: PendingQuestion;
        answers: string[][];
        text: string;
        context: string[];
      } {
    const question = this.questions.get(id);
    if (!question) return { ok: false, error: t("question.missing") };
    const parsed = answersSchema.safeParse(input);
    if (!parsed.success || parsed.data.length !== question.questions.length) return { ok: false, error: t("question.invalid") };
    const answers = parsed.data;
    const context = question.questions.map((item, index) => `${item.header ?? item.question.slice(0, QUESTION_HEADER_LENGTH)}: ${answers[index]!.join(", ")}`);
    const text = `Answer to your question ${id}:\n` + context.map(line => `- ${line}`).join("\n");
    this.questions.delete(id);
    return { ok: true, question, answers, text, context };
  }
}
