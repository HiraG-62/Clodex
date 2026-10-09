// GUI を公開する版を決める（DESIGN.md §28 GUI の自動更新）。
// 使い方: node scripts/release-version.mjs <tag|branch> <ref 名>
// 版を標準出力に出し、package.json の version をその版にする。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));
const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const VERSION_LINE = '^\\s*"version":';
// release.yml の paths-ignore と同じ。build されない変更は数えない
const IGNORED_PATHS = [":(exclude,glob)docs/**", ":(exclude,glob)**/*.md"];

export function releaseVersion({ refType, refName, devNumber, packageVersion }) {
  if (refType === "tag") {
    if (refName !== `v${packageVersion}`) throw new Error(`tag ${refName} と package.json の版 ${packageVersion} が違います`);
    return packageVersion;
  }
  const match = RELEASE_VERSION.exec(packageVersion);
  if (!match) throw new Error(`dev の元にする版が x.y.z ではありません: ${packageVersion}`);
  const [, major, minor, patch] = match;
  return `${major}.${minor}.${Number(patch) + 1}-dev.${devNumber}`;
}

// package.json の版を最後に変えたコミットより後の、build の対象になるコミットの数。本番を出すたびに数え直す
export function devNumber(cwd) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const bump = git("log", "-1", "--format=%H", `-G${VERSION_LINE}`, "--", "package.json");
  if (!bump) throw new Error("package.json の版を変えたコミットが見つかりません");
  return Number(git("rev-list", "--count", `${bump}..HEAD`, "--", ".", ...IGNORED_PATHS));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [refType, refName] = process.argv.slice(2);
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
  const version = releaseVersion({
    refType,
    refName,
    packageVersion: pkg.version,
    ...(refType === "tag" ? {} : { devNumber: devNumber(ROOT) }),
  });
  writeFileSync(PACKAGE_JSON, `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
  console.log(version);
}
