import { t } from "../i18n/i18n.js";

export interface SetupStatus {
  managed: boolean;
  user: boolean;
  credential: boolean;
  claude: boolean;
  codex: boolean;
  pnpm: boolean;
  authenticated: boolean;
}
export const setupComplete = (status: SetupStatus): boolean => Object.values(status).every(Boolean);

export interface SandboxSetupActions {
  cleanup?(): Promise<void>;
  status(): Promise<SetupStatus>;
  createUser(): Promise<void>;
  connect(): Promise<void>;
  install(status: SetupStatus): Promise<void>;
  login(): Promise<void>;
  authenticate(): Promise<boolean>;
  saveComplete(complete: boolean): Promise<void>;
  close(): Promise<void>;
}

export async function ensureSandboxSetup(actions: SandboxSetupActions, notify: (text: string) => void): Promise<void> {
  await actions.cleanup?.();
  let status = await actions.status();
  if (setupComplete(status)) return;
  await actions.saveComplete(false);
  try {
    if (!status.user || !status.credential || !status.managed) {
      notify(t("sandbox.setupUser"));
      await actions.createUser();
    }
    await actions.connect();
    status = await actions.status();
    if (!status.claude || !status.codex || !status.pnpm) {
      notify(t("sandbox.setupCli"));
      await actions.install(status);
    }
    if (!await actions.authenticate()) {
      notify(t("sandbox.setupLogin"));
      await actions.login();
      if (!await actions.authenticate()) throw new Error(t("sandbox.incomplete"));
    }
    await actions.saveComplete(true);
  } catch (error) {
    await actions.saveComplete(false);
    await actions.close();
    throw error;
  }
}
