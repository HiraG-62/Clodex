import { z } from "zod";
import { AGENT_IDS } from "../agents/agent-adapter.js";

export const MIN_QUESTIONS = 1;
export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 6;

const questionSchema = z.object({
  question: z.string().trim().min(1),
  header: z.string().trim().min(1).optional(),
  options: z
    .array(
      z.object({
        label: z.string().trim().min(1),
        description: z.string().optional().describe("One short sentence to compare this option with the others. Do not write the recommendation here"),
        recommended: z.boolean().optional().describe("true for the option you recommend. The UI shows a mark next to the label"),
      }),
    )
    .min(MIN_OPTIONS)
    .max(MAX_OPTIONS),
  multiSelect: z.boolean().optional(),
});
export const askUserShape = { questions: z.array(questionSchema).min(MIN_QUESTIONS).max(MAX_QUESTIONS) };
export const askUserSchema = z.object(askUserShape);
export const pendingQuestionSchema = z.object({ id: z.string().min(1), agent: z.enum(AGENT_IDS), ...askUserShape });
export const answersSchema = z
  .array(z.array(z.string().trim().min(1)).min(1))
  .min(MIN_QUESTIONS)
  .max(MAX_QUESTIONS);
export type UserQuestion = z.infer<typeof questionSchema>;
export type PendingQuestion = z.infer<typeof pendingQuestionSchema>;
export type AskUserResult = { ok: true; id: string } | { ok: false; error: string };
