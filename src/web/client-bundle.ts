import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ClientAssets {
  script: string;
  style: string;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export function loadClientAssets(moduleDir = MODULE_DIR, sourceDir = join(moduleDir, "client")): ClientAssets {
  const scriptPath = join(moduleDir, "client.js");
  const stylePath = join(moduleDir, "style.css");
  if (existsSync(scriptPath) && existsSync(stylePath)) {
    return { script: readFileSync(scriptPath, "utf8"), style: readFileSync(stylePath, "utf8") };
  }

  const { buildSync } = createRequire(import.meta.url)("esbuild") as typeof import("esbuild");
  const result = buildSync({
    entryPoints: [join(sourceDir, "index.ts")],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    minify: false,
    write: false,
    outfile: "client.js",
  });
  const script = result.outputFiles?.[0]?.text;
  if (!script) throw new Error("Client bundle is empty");
  return { script, style: readFileSync(join(sourceDir, "style.css"), "utf8") };
}
