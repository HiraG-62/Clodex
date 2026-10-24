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
  const choice = <T extends string>(label: string, options: readonly T[], current: T, name: (value: T) => string) => {
    let value = current;
    const wrap = ctx.el("div", "mcp-field");
    const group = ctx.el("div", "seg mcp-segment");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", label);
    for (const option of options) {
      const button = ctx.el("button", "", name(option)) as HTMLButtonElement;
      button.type = "button";
      button.setAttribute("aria-pressed", String(option === current));
      button.addEventListener("click", () => {
        value = option;
        for (const selected of group.querySelectorAll<HTMLButtonElement>("button")) selected.setAttribute("aria-pressed", String(selected === button));
        group.dispatchEvent(new Event("change"));
      });
      group.append(button);
    }
    wrap.append(ctx.el("span", "eyebrow", label), group);
    return {
      wrap,
      group,
      get value() {
        return value;
      },
      disable: () => {
        for (const button of group.querySelectorAll<HTMLButtonElement>("button")) button.disabled = true;
      },
    };
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
    const scopeChoice = choice(ctx.t("web.mcp.scope"), ["user", "project"] as const, scope, option => ctx.t(`web.configSource.${option}`));
    if (oldName) scopeChoice.disable();
    const transport = choice(ctx.t("web.mcp.transport"), ["stdio", "http"] as const, original?.transport ?? "stdio", option => option);
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
    transport.group.addEventListener("change", toggleTransport);
    toggleTransport();
    const enabled = ctx.el("button", "settings-switch mcp-switch") as HTMLButtonElement;
    enabled.type = "button";
    enabled.setAttribute("role", "switch");
    enabled.setAttribute("aria-label", ctx.t("web.mcp.enabled"));
    enabled.setAttribute("aria-checked", String(original?.enabled ?? true));
    enabled.addEventListener("click", () => enabled.setAttribute("aria-checked", String(enabled.getAttribute("aria-checked") !== "true")));
    const enabledRow = ctx.el("div", "mcp-enabled");
    enabledRow.append(ctx.el("span", "", ctx.t("web.mcp.enabled")), enabled);
    const agents = Object.fromEntries(
      ctx.AGENT_IDS.map(agent => {
        const button = ctx.el("button", "mcp-agent-chip", ctx.AGENTS[agent].name) as HTMLButtonElement;
        button.type = "button";
        button.dataset.agent = agent;
        button.setAttribute("aria-pressed", String(original?.agents[agent] ?? false));
        button.addEventListener("click", () => button.setAttribute("aria-pressed", String(button.getAttribute("aria-pressed") !== "true")));
        return [agent, button];
      }),
    ) as Record<AgentId, HTMLButtonElement>;
    const agentGroup = ctx.el("div", "mcp-field");
    const agentButtons = ctx.el("div", "mcp-agent-options");
    agentButtons.setAttribute("role", "group");
    agentButtons.setAttribute("aria-label", ctx.t("web.agents.label"));
    agentButtons.append(...ctx.AGENT_IDS.map(agent => agents[agent]));
    agentGroup.append(ctx.el("span", "eyebrow", ctx.t("web.agents.label")), agentButtons);
    const save = ctx.el("button", "primary-action", ctx.t("web.mcp.save")) as HTMLButtonElement;
    save.type = "submit";
    form.append(
      name.wrap,
      scopeChoice.wrap,
      transport.wrap,
      command.wrap,
      args.wrap,
      url.wrap,
      env.wrap,
      envRefs.wrap,
      message(ctx.t("web.mcp.envHint")),
      enabledRow,
      agentGroup,
      save,
    );
    form.addEventListener("submit", event => {
      event.preventDefault();
      const nextName = name.input.value.trim();
      if (!nextName) return;
      const nextScope = scopeChoice.value;
      let next: McpServerConfig;
      try {
        next = {
          transport: transport.value as "stdio" | "http",
          ...(transport.value === "stdio"
            ? { command: command.input.value.trim(), args: args.input.value.split(/\r?\n/).filter(Boolean) }
            : { url: url.input.value.trim() }),
          env: readPairs(env.input.value),
          envRefs: readPairs(envRefs.input.value),
          enabled: enabled.getAttribute("aria-checked") === "true",
          agents: Object.fromEntries(ctx.AGENT_IDS.map(agent => [agent, agents[agent].getAttribute("aria-pressed") === "true"])) as McpServerConfig["agents"],
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
