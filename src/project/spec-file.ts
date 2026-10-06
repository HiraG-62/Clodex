import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, win32 } from "node:path";
import { inside } from "./path-scope.js";

export const isSpecFile = (projectRoot: string, spec: string): boolean => {
  if (isAbsolute(spec) || win32.parse(spec).root) return false;
  try {
    const candidate = resolve(projectRoot, spec.replace(/\\/g, "/"));
    if (!inside(resolve(projectRoot), candidate)) return false;
    const real = realpathSync(candidate);
    return inside(realpathSync(projectRoot), real) && statSync(real).isFile();
  } catch {
    return false;
  }
};
