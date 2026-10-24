import type { AgentId } from "../../agents/agent-adapter.js";
import type { McpServerConfig } from "../../config/config.js";
import type { McpAction, McpEntry } from "../../mcp-manager/manager.js";
import type { ClientContext } from "./store.js";

type Scope = "user" | "project";
interface McpData {
  user: Record<string, McpServerConfig>;
  project: Record<string, McpServerConfig>;
  entries: McpEntry[];
  errors: string[];
}
interface Preview {
  id: string;
  actions: McpAction[];
  entries: McpEntry[];
  errors: string[];
}

const readPairs = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter(line => line.trim())
      .map(line => {
        const separator = line.indexOf("=");
        if (separator < 1) throw new Error(`Invalid entry: ${line}`);
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
      }),
  );
const showPairs = (values: Record<string, string> | undefined): string =>
  Object.entries(values ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
const request = async <T>(path: string, body?: unknown): Promise<T> => {
  const response = await fetch(
    path,
    body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data === "object" && data !== null && "error" in data ? String(data.error) : `HTTP ${response.status}`);
  return data as T;
};

export function createMcpSheet(ctx: ClientContext) {
  let data: McpData | undefined;
  const message = (text: string) => ctx.el("p", "muted small", text);
  const field = (label: string, value = "", tag: "input" | "textarea" = "input") => {
    const wrap = ctx.el("label", "mcp-field");
    const input = ctx.el(tag) as HTMLInputElement | HTMLTextAreaElement;
    input.value = value;
    wrap.append(ctx.el("span", "eyebrow", label), input);
    return { wrap, input };
  };
  const failure = (error: unknown) => ctx.showToast(error instanceof Error ? error.message : String(error), "warn");

  const reload = async () => {
    data = await request<McpData>("/api/mcp");
    renderList();
  };
  const saveScope = async (scope: Scope, servers: Record<string, McpServerConfig>) => {
    await request("/api/mcp/save", { scope, servers });
    await reload();
  };

  const renderEditor = (scope: Scope, oldName?: string) => {
    if (!data) return;
    const original = oldName ? data[scope][oldName] : undefined;
    const form = ctx.el("form", "mcp-editor") as HTMLFormElement;
    const name = field(ctx.t("web.mcp.name"), oldName);
    if (oldName) name.input.disabled = true;
    const scopeSelect = ctx.el("select") as HTMLSelectElement;
    for (const optionName of ["user", "project"] as const) {
      const option = ctx.el("option", "", ctx.t(`web.configSource.${optionName}`)) as HTMLOptionElement;
      option.value = optionName;
      scopeSelect.append(option);
    }
    scopeSelect.value = scope;
    if (oldName) scopeSelect.disabled = true;
    const scopeLabel = ctx.el("label", "mcp-field");
    scopeLabel.append(ctx.el("span", "eyebrow", ctx.t("web.mcp.scope")), scopeSelect);
    const transport = ctx.el("select") as HTMLSelectElement;
    for (const optionName of ["stdio", "http"] as const) {
      const option = ctx.el("option", "", optionName) as HTMLOptionElement;
      option.value = optionName;
      transport.append(option);
    }
    transport.value = original?.transport ?? "stdio";
    const transportLabel = ctx.el("label", "mcp-field");
    transportLabel.append(ctx.el("span", "eyebrow", ctx.t("web.mcp.transport")), transport);
    const command = field(ctx.t("web.mcp.command"), original?.command);
    const args = field(ctx.t("web.mcp.args"), original?.args?.join("\n"), "textarea");
    const url = field(ctx.t("web.mcp.url"), original?.url);
    const env = field(ctx.t("web.mcp.env"), showPairs(original?.env), "textarea");
    const envRefs = field(ctx.t("web.mcp.envRefs"), showPairs(original?.envRefs), "textarea");
    const toggleTransport = () => {
      const stdio = transport.value === "stdio";
      command.wrap.hidden = !stdio;
      args.wrap.hidden = !stdio;
      url.wrap.hidden = stdio;
    };
    transport.addEventListener("change", toggleTransport);
    toggleTransport();
    const enabled = ctx.el("input") as HTMLInputElement;
    enabled.type = "checkbox";
    enabled.checked = original?.enabled ?? true;
    const enabledLabel = ctx.el("label", "mcp-check");
    enabledLabel.append(enabled, ctx.el("span", "", ctx.t("web.mcp.enabled")));
    const agents = Object.fromEntries(
      ctx.AGENT_IDS.map(agent => {
        const box = ctx.el("input") as HTMLInputElement;
        box.type = "checkbox";
        box.checked = original?.agents[agent] ?? false;
        const label = ctx.el("label", "mcp-check");
        label.append(box, ctx.el("span", "", ctx.AGENTS[agent].name));
        return [agent, { box, label }];
      }),
    ) as Record<AgentId, { box: HTMLInputElement; label: HTMLElement }>;
    const save = ctx.el("button", "primary-action", ctx.t("web.mcp.save")) as HTMLButtonElement;
    save.type = "submit";
    form.append(
      name.wrap,
      scopeLabel,
      transportLabel,
      command.wrap,
      args.wrap,
      url.wrap,
      env.wrap,
      envRefs.wrap,
      message(ctx.t("web.mcp.envHint")),
      enabledLabel,
      ...ctx.AGENT_IDS.map(agent => agents[agent].label),
      save,
    );
    form.addEventListener("submit", event => {
      event.preventDefault();
      const nextName = name.input.value.trim();
      if (!nextName) return;
      const nextScope = scopeSelect.value as Scope;
      let next: McpServerConfig;
      try {
        next = {
          transport: transport.value as "stdio" | "http",
          ...(transport.value === "stdio"
            ? { command: command.input.value.trim(), args: args.input.value.split(/\r?\n/).filter(Boolean) }
            : { url: url.input.value.trim() }),
          env: readPairs(env.input.value),
          envRefs: readPairs(envRefs.input.value),
          enabled: enabled.checked,
          agents: Object.fromEntries(ctx.AGENT_IDS.map(agent => [agent, agents[agent].box.checked])) as McpServerConfig["agents"],
        };
      } catch (error) {
        failure(error);
        return;
      }
      if (!oldName && (nextName === "clodex" || nextName in data!.user || nextName in data!.project)) {
        failure(new Error(nextName));
        return;
      }
      void saveScope(nextScope, { ...data![nextScope], [nextName]: next }).catch(failure);
    });
    ctx.openSheet(ctx.t(oldName ? "web.mcp.edit" : "web.mcp.add"), [form]);
  };

  const renderPreview = (preview: Preview) => {
    const content: HTMLElement[] = [];
    for (const action of preview.actions) content.push(message(`${ctx.AGENTS[action.agent].name} · ${action.kind} · ${action.name}`));
    for (const entry of preview.entries.filter(item => item.status === "unsupported"))
      content.push(message(`${ctx.AGENTS[entry.agent].name} · ${entry.name} · ${ctx.t("web.mcp.unsupported")} · ${entry.reason ?? ""}`));
    for (const error of preview.errors) content.push(message(error));
    if (!content.length) content.push(message(ctx.t("web.mcp.empty")));
    if (preview.actions.length && !preview.errors.length) {
      content.push(
        ctx.sheetButton(ctx.t("web.mcp.apply"), "primary-action", button => {
          button.disabled = true;
          void request<{ errors: string[]; applied: McpAction[] }>("/api/mcp/apply", { id: preview.id })
            .then(result => {
              if (result.errors.length) failure(result.errors.join("\n"));
              else ctx.showToast(`${ctx.t("web.mcp.result")}: ${result.applied.length}`);
              return reload();
            })
            .catch(failure);
        }),
      );
    }
    content.push(message(ctx.t("web.mcp.nextStart")));
    ctx.openSheet(ctx.t("web.mcp.preview"), content);
  };

  const renderList = () => {
    if (!data) return;
    ctx.store.sheetKind = "mcp";
    const rows: HTMLElement[] = [];
    for (const [scope, servers] of [
      ["user", data.user],
      ["project", data.project],
    ] as const)
      for (const [name, server] of Object.entries(servers)) {
        const row = ctx.el("div", "mcp-row");
        const title = ctx.el("div", "mcp-row-title", `${name} · ${server.transport} · ${ctx.t(`web.configSource.${scope}`)}`);
        row.append(title);
        const badges = ctx.el("div", "mcp-badges");
        for (const entry of data.entries.filter(item => item.name === name))
          badges.append(ctx.el("span", `mcp-badge mcp-${entry.status}`, `${ctx.AGENTS[entry.agent].name}: ${ctx.t(`web.mcp.${entry.status}`)}`));
        row.append(badges);
        row.append(ctx.sheetButton(ctx.t("web.mcp.edit"), "secondary-action", () => renderEditor(scope, name)));
        row.append(
          ctx.sheetButton(ctx.t("web.mcp.delete"), "secondary-action danger", () => {
            const next = { ...data![scope] };
            delete next[name];
            void saveScope(scope, next).catch(failure);
          }),
        );
        rows.push(row);
      }
    const managed = new Set([...Object.keys(data.user), ...Object.keys(data.project)]);
    for (const name of new Set(data.entries.filter(entry => entry.status === "external" && !managed.has(entry.name)).map(entry => entry.name))) {
      const agents = data.entries.filter(entry => entry.name === name && entry.status === "external").map(entry => ctx.AGENTS[entry.agent].name);
      rows.push(ctx.el("div", "mcp-row", `${name} · ${ctx.t("web.mcp.external")} · ${agents.join(", ")}`));
    }
    if (!rows.length) rows.push(message(ctx.t("web.mcp.empty")));
    rows.push(ctx.sheetButton(ctx.t("web.mcp.add"), "secondary-action", () => renderEditor("project")));
    rows.push(
      ctx.sheetButton(ctx.t("web.mcp.preview"), "primary-action", button => {
        button.disabled = true;
        void request<Preview>("/api/mcp/preview", {})
          .then(renderPreview)
          .catch(failure)
          .finally(() => {
            button.disabled = false;
          });
      }),
    );
    rows.push(message(ctx.t("web.mcp.nextStart")));
    rows.push(message(ctx.t("web.mcp.connectionUnknown")));
    for (const error of data.errors) rows.push(message(error));
    ctx.openSheet(ctx.t("web.mcp.title"), rows);
  };

  const openMcp = () => {
    ctx.store.sheetKind = "mcp";
    ctx.store.sheetAgent = undefined;
    ctx.openSheet(ctx.t("web.mcp.title"), [message(ctx.t("web.files.loading"))]);
    void reload().catch(failure);
  };
  return { openMcp };
}
