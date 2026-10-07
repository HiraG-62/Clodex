import { win32 } from "node:path";
import { subscriptionEnv } from "../agents/agent-process.js";
import { t } from "../i18n/i18n.js";

export function buildAgentEnvironment(profile: string, machine: NodeJS.ProcessEnv, identity: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  if (!/^[A-Za-z]:\\.+/.test(profile)) throw new Error(t("sandbox.incomplete"));
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
  env.PATH = `${win32.join(appData, "npm")};${win32.join(profile, ".local", "bin")};${env.PATH ?? ""}`;
  env.PSMODULEPATH = `${win32.join(profile, "Documents", "WindowsPowerShell", "Modules")};${env.PROGRAMFILES ?? "C:\\Program Files"}\\WindowsPowerShell\\Modules;${env.SYSTEMROOT ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\Modules`;
  for (const key of ["USERNAME", "USERDOMAIN", "COMPUTERNAME"]) if (identity[key]) env[key] = identity[key];
  delete env.HOME;
  delete env.NPM_CONFIG_PACKAGE_IMPORT_METHOD;
  env.npm_config_package_import_method = "copy";
  delete env.PNPM_CONFIG_PACKAGE_IMPORT_METHOD;
  env.pnpm_config_package_import_method = "copy";
  return env;
}
