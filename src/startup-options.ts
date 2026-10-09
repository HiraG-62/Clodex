import type { CliArgs } from "./cli/args.js";
import { resolveProjectRoot } from "./project/project-root.js";

export function initialProject(args: CliArgs, cwd: string, lastProject?: string): string | undefined {
  if (args.project) return resolveProjectRoot({ explicitProject: args.project, cwd });
  return args.serve ? lastProject : resolveProjectRoot({ cwd });
}

export const shouldStartWeb = (args: CliArgs, hasWebConfig: boolean): boolean => args.web || hasWebConfig;
