import { cp, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const RUNTIME = join(ROOT, 'gui', 'src-tauri', 'runtime');
const APP = join(RUNTIME, 'app');
const INSTALL_ARGS = ['install', '--prod', '--frozen-lockfile', '--node-linker=hoisted', '--ignore-scripts'];

await rm(RUNTIME, { recursive: true, force: true });
await mkdir(APP, { recursive: true });
await cp(process.execPath, join(RUNTIME, 'node.exe'));
for (const entry of ['package.json', 'pnpm-lock.yaml', 'dist']) {
  await cp(join(ROOT, entry), join(APP, entry), { recursive: true });
}

const result = spawnSync('pnpm', INSTALL_ARGS, {
  cwd: APP,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`本番用依存関係のインストール失敗: ${result.status}`);
