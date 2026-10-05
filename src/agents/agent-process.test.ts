import { describe, expect, it } from "vitest";
import { agentEnv, subscriptionEnv } from "./agent-process.js";

describe("subscriptionEnv", () => {
  it("API key 系の環境変数を大文字小文字を問わず取り除き、他は残す", () => {
    const env = subscriptionEnv({
      ANTHROPIC_API_KEY: "a",
      anthropic_auth_token: "b",
      OPENAI_API_KEY: "c",
      Codex_Api_Key: "d",
      PATH: "p",
      USERPROFILE: "u",
    });
    expect(env).toEqual({ PATH: "p", USERPROFILE: "u" });
  });
});

describe("agentEnv", () => {
  it("API key を除き、CLODEX_AGENT を設定する", () => {
    expect(agentEnv({ ANTHROPIC_API_KEY: "a", PATH: "p", CLODEX_AGENT: "stale" }, "codex"))
      .toEqual({ PATH: "p", CLODEX_AGENT: "codex" });
  });
});
