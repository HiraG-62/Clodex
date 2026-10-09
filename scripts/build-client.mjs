import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = resolve(process.argv[2] ?? join(root, "dist"));
const webOutput = join(output, "web");
mkdirSync(webOutput, { recursive: true });
buildSync({
  entryPoints: [join(root, "src", "web", "client", "index.ts")],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  minify: false,
  outfile: join(webOutput, "client.js"),
});
copyFileSync(join(root, "src", "web", "client", "style.css"), join(webOutput, "style.css"));
