import type { WebState } from "../web-feed.js";
import type { ClientContext } from "./store.js";

export function createConversationSheets(ctx: ClientContext) {
  const projectEditorList = () => {
    const projects = ctx.store.state?.projects ?? [];
    const list = ctx.el("div", "project-list");
    list.dataset.key = JSON.stringify(projects);
    for (const project of projects) {
      const row = ctx.el("div", `project-row${project.current ? " current" : ""}`);
      const path = ctx.el("span", "project-path", project.projectRoot);
      path.title = project.projectRoot;
      const pin = ctx.iconButton("pin", ctx.t(project.pinned ? "web.conv.unpin" : "web.conv.pin"), "project-pin");
      pin.setAttribute("aria-pressed", String(project.pinned));
      pin.addEventListener("click", () => void ctx.send(`/project pin ${project.projectRoot}`, pin));
      row.append(path, pin);
      // 開いている project は外すと Agent を止めることになるので、外すボタンを出さない
      if (project.open) row.append(ctx.el("span"));
      else {
        const remove = ctx.iconButton("x", ctx.t("web.top.removeProject"), "project-remove");
        remove.addEventListener("click", () => void ctx.send(`/project remove ${project.projectRoot}`, remove));
        row.append(remove);
      }
      list.append(row);
    }
    return list;
  };
  const openProjectEditor = () => {
    ctx.store.sheetKind = "projects";
    ctx.store.sheetAgent = undefined;
    ctx.openSheet(ctx.t("web.top.editProjects"), [projectEditorList()]);
  };
  const openConversationMenu = (conversation: WebState["conversations"][number], number: number) => {
    ctx.store.sheetKind = "conversationMenu";
    ctx.store.sheetAgent = undefined;
    const title = conversation.title ?? ctx.t("web.conv.untitled");
    const actions: HTMLElement[] = [];
    actions.push(
      ctx.sheetButton(ctx.t("web.conv.rename"), "secondary-action", button => {
        const name = window.prompt(ctx.t("web.conv.renamePrompt"), conversation.title ?? "")?.trim();
        if (name)
          void ctx.send(`/rename #${number} ${name}`, button).then(ok => {
            if (ok) ctx.closeSheet();
          });
        else ctx.closeSheet();
      }),
    );
    actions.push(
      ctx.sheetButton(ctx.t(conversation.pinned ? "web.conv.unpin" : "web.conv.pin"), "secondary-action", button => {
        void ctx.send(`/pin ${number}`, button).then(ok => {
          if (ok) ctx.closeSheet();
        });
      }),
    );
    if (!conversation.current) {
      actions.push(
        ctx.sheetButton(ctx.t("web.conv.delete"), "secondary-action danger", button => {
          if (window.confirm(ctx.t("web.conv.deleteConfirm", { title })))
            void ctx.send(`/delete ${number}`, button).then(ok => {
              if (ok) ctx.closeSheet();
            });
          else ctx.closeSheet();
        }),
      );
    }
    ctx.openSheet(title, actions);
  };
  return { openConversationMenu, openProjectEditor, projectEditorList };
}
