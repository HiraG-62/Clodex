import { z } from "zod";
import { MAX_BODY_LENGTH } from "./messages.js";

export const tellUserShape = { body: z.string().describe("Markdown text to show to the human") };
export const tellUserSchema = z.object({
  body: tellUserShape.body.max(MAX_BODY_LENGTH).refine(body => body.trim().length > 0, "body must not be blank"),
});
export type TellUserResult = { ok: true; id: string } | { ok: false; error: string };
