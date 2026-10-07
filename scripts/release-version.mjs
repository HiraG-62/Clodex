// GUI を公開する版を決める（DESIGN.md §28 GUI の自動更新）。
// 使い方: node scripts/release-version.mjs <tag|branch> <ref 名> <実行番号>
// 版を標準出力に出し、package.json の version をその版にする。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url));
const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

export function releaseVersion({ refType, refName, runNumber, packageVersion }) {
  if (refType === 'tag') {
    if (refName !== `v${packageVersion}`) throw new Error(`tag ${refName} と package.json の版 ${packageVersion} が違います`);
    return packageVersion;
  }
  const match = RELEASE_VERSION.exec(packageVersion);
  if (!match) throw new Error(`dev の元にする版が x.y.z ではありません: ${packageVersion}`);
  const [, major, minor, patch] = match;
  return `${major}.${minor}.${Number(patch) + 1}-dev.${runNumber}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [refType, refName, runNumber] = process.argv.slice(2);
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
  const version = releaseVersion({ refType, refName, runNumber, packageVersion: pkg.version });
  writeFileSync(PACKAGE_JSON, `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
  console.log(version);
}
