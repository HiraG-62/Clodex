export const CONTEXT_INSTRUCTION = "[Clodex] Before responding, use read_conversation to read relevant message bodies from this conversation, including exchanges between the human and the other agent. Follow nextBefore for older messages if needed.";

const CONTEXT_SUFFIX = `\n\n${CONTEXT_INSTRUCTION}`;

export const withoutContextInstruction = (text: string): string =>
  text.endsWith(CONTEXT_SUFFIX) ? text.slice(0, -CONTEXT_SUFFIX.length) : text;
