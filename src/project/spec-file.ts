import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, win32 } from "node:path";
import { inside } from "./path-scope.js";

// project root の中の通常ファイルなら実パスを返す（native: Windows の 8.3 の短い名前を git と同じ長い名前にする）
export const resolveSpecFile = (projectRoot: string, spec: string): string | undefined => {
  if (isAbsolute(spec) || win32.parse(spec).root) return undefined;
  try {
    const candidate = resolve(projectRoot, spec.replace(/\\/g, "/"));
    if (!inside(resolve(projectRoot), candidate)) return undefined;
    const real = realpathSync.native(candidate);
    return inside(realpathSync.native(projectRoot), real) && statSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
};
