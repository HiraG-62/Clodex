import { createAgentSettings } from "./agent-settings.js";
import { createAgentStrip } from "./agent-strip.js";
import { createArtifactsLightbox } from "./artifacts-lightbox.js";
import { createComposer } from "./composer.js";
import { createConnection } from "./connection.js";
import { createConversationSheets } from "./conversation-sheets.js";
import { createDom } from "./dom.js";
import { createGuiPush } from "./gui-push.js";
import { createLogItem } from "./log-item.js";
import { createLogView } from "./log-view.js";
import { createPendingView } from "./pending-view.js";
import { createQuestionDock } from "./question-dock.js";
import { createSend } from "./send.js";
import { createSettingsRefresh } from "./settings-refresh.js";
import { createSettingsSheet } from "./settings-sheet.js";
import { createSheets } from "./sheets.js";
import { createStateView } from "./state-view.js";
import { type ClientDeps, createStore } from "./store.js";
import { createStoreInit } from "./store-init.js";
import { createThemeToast } from "./theme-toast.js";
import { createViewport } from "./viewport.js";

export type { ClientDeps } from "./store.js";

export function clientMain(deps: ClientDeps): void {
  const ctx = createStore(deps);
  Object.assign(ctx, createDom(ctx));
  Object.assign(ctx, createStoreInit(ctx));
  Object.assign(ctx, createSend(ctx));
  Object.assign(ctx, createThemeToast(ctx));
  Object.assign(ctx, createLogItem(ctx));
  Object.assign(ctx, createQuestionDock(ctx));
  Object.assign(ctx, createLogView(ctx));
  Object.assign(ctx, createAgentStrip(ctx));
  Object.assign(ctx, createStateView(ctx));
  Object.assign(ctx, createPendingView(ctx));
  Object.assign(ctx, createSheets(ctx));
  Object.assign(ctx, createArtifactsLightbox(ctx));
  Object.assign(ctx, createConversationSheets(ctx));
  Object.assign(ctx, createAgentSettings(ctx));
  Object.assign(ctx, createSettingsSheet(ctx));
  Object.assign(ctx, createGuiPush(ctx));
  Object.assign(ctx, createSettingsRefresh(ctx));
  Object.assign(ctx, createViewport(ctx));
  Object.assign(ctx, createComposer(ctx));
  Object.assign(ctx, createConnection(ctx));
}
