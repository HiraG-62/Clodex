import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FONT_WEIGHTS = {
  "geist-sans": [400, 500, 600],
  "geist-mono": [400, 500],
  "zen-kaku-gothic-new": [400, 500, 700],
} as const;

type FontPackage = keyof typeof FONT_WEIGHTS;

interface FontSource {
  directory: string;
  version: string;
}

const sources = Object.fromEntries(
  (Object.keys(FONT_WEIGHTS) as FontPackage[]).map((name) => {
    const packageFile = fileURLToPath(import.meta.resolve(`@fontsource/${name}/package.json`));
    const metadata: unknown = JSON.parse(readFileSync(packageFile, "utf8"));
    if (typeof metadata !== "object" || metadata === null || !("version" in metadata) || typeof metadata.version !== "string") {
      throw new Error(`Invalid font package version: ${name}`);
    }
    return [name, { directory: dirname(packageFile), version: metadata.version }];
  }),
) as Record<FontPackage, FontSource>;

export const rewriteFontCss = (css: string, name: FontPackage, version: string): string => css
  .replace(/,\s*url\(\.\/files\/[^)]+\.woff\)\s*format\(['"]woff['"]\)/g, "")
  .replace(/url\(\.\/files\/([^)/]+\.woff2)\)/g, (_, fileName: string) =>
    `url(/fonts/${name}@${version}/${fileName})`)
  .replace(/font-family: 'Geist Sans';/g, "font-family: 'Geist';");

export const loadFontCss = (): string => (Object.keys(FONT_WEIGHTS) as FontPackage[])
  .flatMap((name) => FONT_WEIGHTS[name].map((weight) => {
    const source = sources[name];
    const css = readFileSync(join(source.directory, `${weight}.css`), "utf8");
    return rewriteFontCss(css, name, source.version);
  }))
  .join("\n");

export const fontFilePath = (pathname: string): string | undefined => {
  const match = /^\/fonts\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!match) return undefined;
  let packageName: string;
  let fileName: string;
  try {
    packageName = decodeURIComponent(match[1]!);
    fileName = decodeURIComponent(match[2]!);
  } catch {
    return undefined;
  }
  const [name, version] = packageName.split("@");
  if (!name || !Object.hasOwn(FONT_WEIGHTS, name) || !version) return undefined;
  const source = sources[name as FontPackage];
  if (version !== source.version || !/^[a-z0-9-]+\.woff2$/.test(fileName)) return undefined;
  return join(source.directory, "files", fileName);
};
