import { lstat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { t } from "../i18n/i18n.js";

export type GrantKind = "modify" | "git-root" | "git-file" | "git-hooks";
export interface GitProtectionPath { path: string; kind: GrantKind }
export function isMissing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }

export async function gitProtectionPaths(project: string): Promise<GitProtectionPath[]> {
  const marker = join(project, ".git");
  let stat;
  try { stat = await lstat(marker); } catch (error) { if (isMissing(error)) return []; throw error; }
  if (stat.isSymbolicLink()) throw new Error(t("sandbox.reparse", {path:marker}));
  if (stat.isDirectory()) return [{ path: marker, kind: "git-root" }];
  const text = (await readFile(marker, "utf8")).trim();
  if (!text.startsWith("gitdir: ") || /[\r\n]/.test(text)) throw new Error(t("sandbox.pathDenied", {path:marker}));
  const directory = resolve(dirname(marker), text.slice("gitdir: ".length));
  const result: GitProtectionPath[] = [{ path: marker, kind: "git-file" }, { path: directory, kind: "git-root" }];
  try {
    const common = resolve(directory, (await readFile(join(directory, "commondir"), "utf8")).trim());
    if (common !== directory) result.push({ path: common, kind: "git-root" });
  } catch (error) { if (!isMissing(error)) throw error; }
  return result;
}
