import { expect, it, vi } from "vitest";
import { ensureSandboxSetup, type SandboxSetupActions, type SetupStatus } from "./setup.js";

function fixture(initial: Partial<SetupStatus> = {}) {
  const state: SetupStatus = { managed: false, user: false, credential: false, claude: false, codex: false, pnpm: false, authenticated: false, ...initial };
  const actions: SandboxSetupActions = {
    status: vi.fn(async () => ({ ...state })),
    createUser: vi.fn(async () => {
      state.user = true;
      state.credential = true;
      state.managed = true;
    }),
    connect: vi.fn(async () => {}),
    install: vi.fn(async () => {
      state.claude = true;
      state.codex = true;
      state.pnpm = true;
    }),
    login: vi.fn(async () => {
      state.authenticated = true;
    }),
    authenticate: vi.fn(async () => state.authenticated),
    saveComplete: vi.fn(async complete => {
      state.authenticated = complete;
    }),
    close: vi.fn(async () => {}),
  };
  return { state, actions };
}

it("初回はユーザー・CLI・ログインの順に進め、2 回目は再作成しない", async () => {
  const { actions } = fixture();
  await ensureSandboxSetup(actions, () => {});
  await ensureSandboxSetup(actions, () => {});
  expect(actions.createUser).toHaveBeenCalledOnce();
  expect(actions.install).toHaveBeenCalledOnce();
  expect(actions.login).toHaveBeenCalledOnce();
  expect(actions.saveComplete).toHaveBeenLastCalledWith(true);
});

it("CLI の途中失敗後はユーザーを再作成せず残りの段階を再開する", async () => {
  const { actions, state } = fixture();
  vi.mocked(actions.install).mockImplementationOnce(async () => {
    state.claude = true;
    throw new Error("ネットワーク");
  });
  await expect(ensureSandboxSetup(actions, () => {})).rejects.toThrow("ネットワーク");
  expect(actions.saveComplete).toHaveBeenLastCalledWith(false);
  await ensureSandboxSetup(actions, () => {});
  expect(actions.createUser).toHaveBeenCalledOnce();
  expect(actions.install).toHaveBeenLastCalledWith(expect.objectContaining({ claude: true, codex: false }));
});

it("ログイン画面を閉じただけではセットアップ済みにしない", async () => {
  const { actions } = fixture({ managed: true, user: true, credential: true, claude: true, codex: true, pnpm: true });
  vi.mocked(actions.login).mockResolvedValueOnce(undefined);
  await expect(ensureSandboxSetup(actions, () => {})).rejects.toThrow();
  expect(actions.createUser).not.toHaveBeenCalled();
  expect(actions.install).not.toHaveBeenCalled();
  expect(actions.saveComplete).toHaveBeenLastCalledWith(false);
  expect(actions.close).toHaveBeenCalledOnce();
});
