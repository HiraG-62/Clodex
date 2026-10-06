import { win32 } from "node:path";
import { subscriptionEnv } from "../agents/agent-process.js";

export function buildAgentEnvironment(profile: string, machine: NodeJS.ProcessEnv, identity: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  if (!/^[A-Za-z]:\\.+/.test(profile)) throw new Error("専用ユーザーのプロファイルを判定不可");
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(subscriptionEnv(machine))) env[key.toUpperCase()] = value;
  env.SYSTEMROOT ??= "C:\\Windows";
  env.WINDIR ??= env.SYSTEMROOT;
  env.COMSPEC ??= win32.join(env.SYSTEMROOT, "System32", "cmd.exe");
  env.PROGRAMFILES ??= "C:\\Program Files";
  const appData = win32.join(profile, "AppData", "Roaming");
  env.USERPROFILE = profile;
  env.HOMEDRIVE = profile.slice(0, 2);
  env.HOMEPATH = profile.slice(2);
  env.APPDATA = appData;
  env.LOCALAPPDATA = win32.join(profile, "AppData", "Local");
  env.TEMP = win32.join(env.LOCALAPPDATA, "Temp");
  env.TMP = env.TEMP;
  env.PATH = `${win32.join(profile, ".local", "bin")};${win32.join(appData, "npm")};${env.PATH ?? ""}`;
  env.PSMODULEPATH = `${win32.join(profile, "Documents", "WindowsPowerShell", "Modules")};${env.PROGRAMFILES ?? "C:\\Program Files"}\\WindowsPowerShell\\Modules;${env.SYSTEMROOT ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\Modules`;
  for (const key of ["USERNAME", "USERDOMAIN", "COMPUTERNAME"]) if (identity[key]) env[key] = identity[key];
  delete env.HOME;
  return env;
}
