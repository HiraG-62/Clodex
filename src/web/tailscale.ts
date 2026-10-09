import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const DEFAULT_EXECUTABLE = "C:\\Program Files\\Tailscale\\tailscale.exe";
const TIMEOUT_MS = 3_000;
const execFileAsync = promisify(execFile);

const statusSchema = z.object({ BackendState: z.string(), Self: z.object({ DNSName: z.string() }).optional() });
const handlerSchema = z.object({ Proxy: z.string().optional() });
const serveSchema = z.object({
  TCP: z.record(z.string(), z.object({ HTTPS: z.boolean().optional() })).optional(),
  Web: z.record(z.string(), z.object({ Handlers: z.record(z.string(), handlerSchema) })).optional(),
});

export type ConnectionStatus = { state: "ready"; url: string } | { state: "noServe" | "stopped" | "missing" };

const parseOutput = <T>(raw: string, schema: z.ZodType<T>, command: string): T => {
  try {
    return schema.parse(JSON.parse(raw));
  } catch {
    throw new Error(`${command}: invalid JSON`);
  }
};

export const findTailscaleExecutable = (path: string | undefined, exists: (path: string) => boolean = existsSync): string | undefined => {
  for (const directory of path?.split(delimiter) ?? []) {
    if (!directory) continue;
    const candidate = join(directory, "tailscale.exe");
    if (exists(candidate)) return candidate;
  }
  return exists(DEFAULT_EXECUTABLE) ? DEFAULT_EXECUTABLE : undefined;
};

export const interpretTailscale = (statusRaw: string, serveRaw: string, port: number): ConnectionStatus => {
  const status = parseOutput(statusRaw, statusSchema, "tailscale status");
  if (status.BackendState !== "Running") return { state: "stopped" };
  if (!status.Self?.DNSName) throw new Error("tailscale status: missing DNSName");
  const dnsName = status.Self.DNSName.replace(/\.$/, "").toLowerCase();
  const serve = parseOutput(serveRaw, serveSchema, "tailscale serve status");
  for (const [entry, web] of Object.entries(serve.Web ?? {})) {
    let entrance: URL;
    try {
      entrance = new URL(`https://${entry}`);
    } catch {
      throw new Error("tailscale serve status: invalid HTTPS entrance");
    }
    const entrancePort = entrance.port || "443";
    if (entrance.hostname.toLowerCase() !== dnsName || serve.TCP?.[entrancePort]?.HTTPS !== true) continue;
    for (const [path, handler] of Object.entries(web.Handlers)) {
      if (path !== "/" || !handler.Proxy) continue;
      let proxy: URL;
      try {
        proxy = new URL(handler.Proxy);
      } catch {
        throw new Error("tailscale serve status: invalid proxy URL");
      }
      if (proxy.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(proxy.hostname) || Number(proxy.port) !== port) continue;
      return { state: "ready", url: `${entrance.origin}/` };
    }
  }
  return { state: "noServe" };
};

type Run = (executable: string, args: readonly string[]) => Promise<string>;
const runCommand: Run = async (executable, args) => {
  const { stdout } = await execFileAsync(executable, [...args], { timeout: TIMEOUT_MS, windowsHide: true });
  return stdout;
};

export const queryTailscale = async (
  port: number,
  options: { path?: string; exists?: (path: string) => boolean; run?: Run } = {},
): Promise<ConnectionStatus> => {
  const executable = findTailscaleExecutable(options.path ?? process.env.PATH, options.exists);
  if (!executable) return { state: "missing" };
  const run = options.run ?? runCommand;
  const status = await run(executable, ["status", "--json"]);
  const parsed = parseOutput(status, statusSchema, "tailscale status");
  if (parsed.BackendState !== "Running") return { state: "stopped" };
  const serve = await run(executable, ["serve", "status", "--json"]);
  return interpretTailscale(status, serve, port);
};
