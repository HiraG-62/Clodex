import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { withAdminErrorReport } from "./admin-error.js";
import { psQuote, runHost } from "./powershell.js";

it.runIf(process.platform === "win32")("昇格側の例外メッセージだけをファイルへ返す",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"clodex-admin-error-"));
  const path=join(dir,"fixture.ps1");
  const source=withAdminErrorReport("param()\n$ErrorActionPreference='Stop'\nthrow 'プロファイル使用中'");
  await writeFile(path,`\uFEFF${source}`);
  await expect(runHost(`& ${psQuote(path)};exit $LASTEXITCODE`)).rejects.toThrow();
  expect(await readFile(join(dir,"error"),"utf8")).toBe("プロファイル使用中");
});
