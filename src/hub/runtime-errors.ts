import type { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const RECOVERABLE_IO = new Set(["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED"]);
const EXIT_FAILURE = 1;
interface RuntimeErrorOptions {
  home: string;
  report(message: string): void;
  events?: EventEmitter;
  exit?(code: number): void;
  stderr?(text: string): void;
}

export function installRuntimeErrors({ home, report, events = process, exit = code => process.exit(code), stderr = text => { writeSync(process.stderr.fd, text); } }: RuntimeErrorOptions) {
  const directory = join(home, ".clodex", "logs");
  const logPath = join(directory, `hub-errors-${Date.now()}-${process.pid}.log`);
  const record = (error: unknown, kind: string, fatal: boolean) => {
    const message = error instanceof Error ? error.message : String(error);
    const at = new Date().toISOString();
    const text = `${at} ${kind}: ${error instanceof Error ? error.stack ?? message : message}\n`;
    try { mkdirSync(directory, { recursive: true }); appendFileSync(logPath, text); }
    catch { /* stderr にも記録する。 */ }
    try { stderr(text); } catch { /* stderr の切断で例外処理を再入させない。 */ }
    if (fatal) {
      try { writeFileSync(join(home, ".clodex", "hub-failure.json"), JSON.stringify({ at, message, logPath })); }
      catch { /* ログの失敗でも異常終了を優先する。 */ }
    }
    try { report(message); } catch { /* UI の障害で例外処理を再入させない。 */ }
    if (fatal) exit(EXIT_FAILURE);
  };
  const fatal = (error: unknown) => record(error, "fatal", true);
  const rejection = (error: unknown) => record(error, "unhandledRejection", false);
  const exception = (error: unknown) => {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    record(error, "uncaughtException", typeof code !== "string" || !RECOVERABLE_IO.has(code));
  };
  events.on("unhandledRejection", rejection);
  events.on("uncaughtException", exception);
  return { logPath, fatal, dispose: () => { events.off("unhandledRejection", rejection); events.off("uncaughtException", exception); } };
}
