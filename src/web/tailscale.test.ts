import { describe, expect, it } from "vitest";
import { findTailscaleExecutable, interpretTailscale } from "./tailscale.js";

const status = (backendState = "Running") => JSON.stringify({ BackendState: backendState, Self: { DNSName: "desktop.example.ts.net." } });
const serve = (entry = "desktop.example.ts.net:443", path = "/", proxy = "http://127.0.0.1:4319") =>
  JSON.stringify({ TCP: { [entry.split(":").at(-1)!]: { HTTPS: true } }, Web: { [entry]: { Handlers: { [path]: { Proxy: proxy } } } } });

describe("interpretTailscale", () => {
  it("443 の root handler から HTTPS の URL を返す", () => {
    expect(interpretTailscale(status(), serve(), 4319)).toEqual({ state: "ready", url: "https://desktop.example.ts.net/" });
  });
  it("443 以外のポートを URL に残す", () => {
    expect(interpretTailscale(status(), serve("desktop.example.ts.net:8443"), 4319)).toEqual({ state: "ready", url: "https://desktop.example.ts.net:8443/" });
  });
  it("Hub と違うポートだけの proxy と未設定の serve は noServe", () => {
    expect(interpretTailscale(status(), serve("desktop.example.ts.net:443", "/", "http://127.0.0.1:9999"), 4319)).toEqual({ state: "noServe" });
    expect(interpretTailscale(status(), "{}", 4319)).toEqual({ state: "noServe" });
  });
  it("パス付き handler だけなら noServe", () => {
    expect(interpretTailscale(status(), serve("desktop.example.ts.net:443", "/clodex"), 4319)).toEqual({ state: "noServe" });
  });
  it("Running 以外なら stopped", () => {
    expect(interpretTailscale(status("Stopped"), serve(), 4319)).toEqual({ state: "stopped" });
  });
  it("想定外の JSON はエラーにする", () => {
    expect(() => interpretTailscale('{"BackendState":"Running","Self":{}}', serve(), 4319)).toThrow("tailscale status");
    expect(() => interpretTailscale(status(), '{"Web":[]}', 4319)).toThrow("tailscale serve status");
  });
});

describe("findTailscaleExecutable", () => {
  it("PATH、既定の場所、無しの順に解決する", () => {
    const pathCandidate = "C:\\Tools\\tailscale.exe";
    const defaultCandidate = "C:\\Program Files\\Tailscale\\tailscale.exe";
    expect(findTailscaleExecutable("C:\\Tools", candidate => candidate === pathCandidate || candidate === defaultCandidate)).toBe(pathCandidate);
    expect(findTailscaleExecutable("C:\\Tools", candidate => candidate === defaultCandidate)).toBe(defaultCandidate);
    expect(findTailscaleExecutable("C:\\Tools", () => false)).toBeUndefined();
  });
});
