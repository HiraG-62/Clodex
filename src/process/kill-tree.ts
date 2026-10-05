import { spawn } from "node:child_process";

// Windows では親だけを kill しても子プロセスが残る
export const killProcessTree = (pid: number): void => {
  spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
    .on("error", () => {});
};
