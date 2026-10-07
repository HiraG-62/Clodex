import { expect, it } from "vitest";
import { buildAgentEnvironment } from "./environment.js";

it("agent のプロファイルと Machine PATH で環境を構築し、人の HOME と API key を除く", () => {
  const env = buildAgentEnvironment("C:\\Users\\clodex-agent", {
    Path: "C:\\Windows;C:\\Program Files\\nodejs", HOME: "C:\\Users\\human", OpenAI_API_KEY: "secret", PSModulePath: "C:\\PowerShell7", SystemRoot: "C:\\Windows",
  }, { USERNAME: "clodex-agent" });
  expect(env.USERPROFILE).toBe("C:\\Users\\clodex-agent");
  expect(env.APPDATA).toBe("C:\\Users\\clodex-agent\\AppData\\Roaming");
  expect(env.TEMP).toBe("C:\\Users\\clodex-agent\\AppData\\Local\\Temp");
  expect(env.PATH).toBe("C:\\Users\\clodex-agent\\AppData\\Roaming\\npm;C:\\Users\\clodex-agent\\.local\\bin;C:\\Windows;C:\\Program Files\\nodejs");
  expect(env.PSMODULEPATH).not.toContain("PowerShell7");
  expect(env.HOME).toBeUndefined();
  expect(env.OPENAI_API_KEY).toBeUndefined();
  expect(env.USERNAME).toBe("clodex-agent");
  expect(env.npm_config_package_import_method).toBeUndefined();
  expect(env.pnpm_config_package_import_method).toBeUndefined();
  expect(env.NPM_CONFIG_PACKAGE_IMPORT_METHOD).toBeUndefined();
  expect(env.PNPM_CONFIG_PACKAGE_IMPORT_METHOD).toBeUndefined();
});

it("取得できなかったプロファイルを人のプロファイルで代用しない", () => {
  expect(() => buildAgentEnvironment("", {})).toThrow();
});
