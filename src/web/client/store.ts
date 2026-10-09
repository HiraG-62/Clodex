import type { AgentId, AgentStatus, TurnResult } from "../../agents/agent-adapter.js";
import type { SlashCommand } from "../../cli/commands.js";
import type { AgentState } from "../../cli/shell.js";
import type { MessageKey, Messages } from "../../i18n/messages.js";
import type { WEB_LAYOUT } from "../layout.js";
import type { GuiAction, GuiInfo, HistoryItem, WebState } from "../web-feed.js";
import type { CommandStarts, PendingDeadlines, PendingSettings } from "./pending.js";
import type { SendKey } from "./send-key.js";
import type { DisplayTimelineItem, TimelineItem } from "./timeline.js";

export interface ClientDeps {
  layout: typeof WEB_LAYOUT;
  commands: readonly SlashCommand[];
  messages: Messages;
  version: string;
}

export interface SharedStore {
  pendingRequests: Set<string>;
  interrupting: Set<"claude" | "codex">;
  state: WebState | undefined;
  interruptAttempts: Map<"claude" | "codex", symbol>;
  liveGeneration: number;
  pendingSettings: PendingSettings;
  settingRequests: Map<string, symbol>;
  pendingDeadlines: PendingDeadlines;
  opened: Map<string, boolean>;
  detail: boolean;
  questionDrafts: Map<string, { selected: Set<number>[]; other: string[]; step: number }>;
  unreadWhileReading: boolean;
  items: TimelineItem[];
  rendered: Map<string, { item: DisplayTimelineItem; node: HTMLElement }>;
  startingAt: Map<"claude" | "codex", string>;
  historyLoading: boolean;
  commandStarts: CommandStarts;
  controlUpdaters: WeakMap<HTMLElement, (agent: AgentState) => void>;
  target: AgentId | undefined;
  sheetAgent: AgentId | undefined;
  usageAgent: AgentId | undefined;
  sheetKind: "agent" | "agentSettings" | "settings" | "conversations" | "conversationMenu" | "projects" | "artifacts" | "viewer" | undefined;
  sendKey: SendKey;
  gui: GuiInfo | null;
  settingsRequests: Set<string>;
  theme: "system" | "light" | "dark";
  uploading: number;
  currentDraftKey: string | undefined;
  history: HistoryItem[];
  historyHasMore: boolean;
  replaying: boolean;
  historyGeneration: number;
  incomingHistory: HistoryItem[];
  replayAnchor: { id: string; top: number } | undefined;
  replayScheduled: boolean;
  guiVersion: string | undefined;
  pushId: string | undefined;
  reloading: boolean;
  files: string[];
  fileSet: Set<string>;
  filesLoadedAt: number;
  filesLoading: boolean;
  filesGeneration: number;
  pendingPrimary: AgentId | undefined;
}

type Theme = "system" | "light" | "dark";
type ProjectEntry = NonNullable<WebState["projects"]>[number];

export interface ClientContext extends ClientDeps {
  store: SharedStore;
  storage: { get: (key: string) => string | null; set: (key: string, value: string) => void; remove: (key: string) => void; keys: () => string[] };
  DETAIL_KEY: "clodex-detail";
  $: <T extends HTMLElement>(selector: string) => T;
  showToast: (text: string, level?: "info" | "warn", heading?: string) => void;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
  INTERRUPT_RETRY_MS: 5000;
  renderState: () => void;
  SETTING_TIMEOUT_MS: 5000;
  refreshOpenSheet: () => void;
  THEMES: readonly ["system", "light", "dark"];
  THEME_KEY: "clodex-theme";
  SEND_KEYS: readonly SendKey[];
  SEND_KEY_KEY: "clodex-send-key";
  THEME_LABEL: Record<Theme, MessageKey>;
  icon: (name: string) => SVGSVGElement;
  el: (tag: string, className?: string, text?: string) => HTMLElement;
  TOAST_EXIT_MS: 150;
  TOAST_DURATION_MS: 4000;
  MAX_TOASTS: 3;
  MS_PER_SECOND: 1000;
  SECONDS_PER_MINUTE: 60;
  openImage: (path: string, version?: string) => void;
  fileUrl: (api: "file" | "diff", path: string, version?: string) => string;
  mark: (agent: AgentId | "you") => HTMLElement;
  AGENTS: Record<AgentId, { name: string; mark: string }>;
  clock: (iso: string) => string;
  TURN_LABEL: Record<"working" | TurnResult["status"], MessageKey | undefined>;
  openViewer: (path: string) => Promise<void>;
  send: (line: string, button?: HTMLButtonElement) => Promise<boolean>;
  appendImagePreviews: (node: HTMLElement, text: string, version: string) => void;
  elapsedText: (startIso: string) => string;
  renderQuestion: (item: Extract<TimelineItem, { kind: "question" }>) => HTMLElement;
  renderTurn: (item: Extract<TimelineItem, { kind: "turn" }>) => HTMLElement;
  renderMessage: (item: Pick<Extract<TimelineItem, { kind: "message" }>, "id" | "at" | "message" | "envelope">) => HTMLElement;
  log: HTMLElement;
  NEAR_BOTTOM_PX: 120;
  newer: HTMLElement;
  CODE_FOLD_LINES: 8;
  iconButton: (name: string, label: string, cls?: string) => HTMLButtonElement;
  AGENT_IDS: AgentId[];
  shortDate: (iso: string) => string;
  kTokens: (n: number) => string;
  PERCENT: 100;
  displayDefault: (value: string | undefined) => string;
  displayedAgent: (agent: AgentState) => AgentState;
  STATUS_LABEL: Record<AgentStatus, MessageKey>;
  openAgentSettings: (id: AgentId) => void;
  mobile: MediaQueryList;
  wideUsage: MediaQueryList;
  USAGE_POPOVER_GAP_PX: 8;
  EDIT_PROJECTS_VALUE: "clodex:edit-projects";
  renderQuestionDock: (force?: boolean) => undefined;
  sheet: HTMLElement;
  subagentBadge: (agent: AgentState) => HTMLElement | undefined;
  openAgentSheet: (id: AgentId) => void;
  input: HTMLTextAreaElement;
  stateLabel: (agent: AgentState) => HTMLElement;
  agentControls: (agent: AgentState) => HTMLElement;
  closeUsage: () => void;
  refreshUsage: () => void;
  conversationList: () => HTMLElement[];
  syncTargetButtons: () => void;
  renderPending: () => void;
  syncPendingButtons: () => void;
  REFERENCES_SEPARATOR: "\n\nReferenced files:\n";
  onInputChanged: () => void;
  closeSheet: () => void;
  openConversationMenu: (conversation: WebState["conversations"][number], number: number) => void;
  fillProjectSelect: (select: HTMLSelectElement, projects: readonly ProjectEntry[]) => void;
  pushSupported: boolean;
  openProjectEditor: () => void;
  ARTIFACT_LABEL: Record<"changed" | "referenced" | "image", MessageKey>;
  openSheet: (title: string, content: HTMLElement[]) => void;
  rememberFocus: () => HTMLElement | undefined;
  restoreFocus: (previous: HTMLElement | undefined) => void;
  trapTab: (event: KeyboardEvent, container: HTMLElement) => void;
  choice: <T extends string>(
    key: string,
    label: string,
    options: readonly T[],
    current: T,
    name: (v: T) => string,
    pick: (v: T, button: HTMLButtonElement) => void,
  ) => HTMLElement;
  sheetButton: (label: string, cls: string, run: (button: HTMLButtonElement) => void) => HTMLButtonElement;
  PERMISSIONS: readonly ["read-only", "edit", "full"];
  requestSetting: (id: AgentId, key: "model" | "effort" | "permission", value: string, button?: HTMLButtonElement) => Promise<boolean>;
  EFFORTS: Record<AgentId, readonly string[]>;
  setPending: (button: HTMLButtonElement, pending: boolean) => void;
  pushSection: () => HTMLElement;
  guiUpdateSection: () => HTMLElement;
  withPending: <T>(button: HTMLButtonElement | undefined, operation: () => Promise<T>) => Promise<T>;
  settingsSwitch: (key: string, label: string, checked: boolean, pick: (checked: boolean, button: HTMLButtonElement) => void) => HTMLElement;
  projectEditorList: () => HTMLElement;
  refreshGuiUpdate: (body: HTMLElement) => void;
  refreshPush: (body: HTMLElement) => void;
  syncLimitActions: (form: HTMLElement) => void;
  openConversations: () => void;
  THEME_ICON: Record<Theme, string>;
  syncThemeButton: (button: HTMLButtonElement, text: boolean) => void;
  cycleTheme: () => void;
  SWIPE_CLOSE_PX: 72;
  KEYBOARD_THRESHOLD_PX: 120;
  openSettings: () => void;
  openArtifacts: () => void;
  renderLog: (force?: boolean) => void;
  nearBottom: () => boolean;
  scrollToBottom: () => void;
  SUGGEST_TAP_SLOP_PX: 10;
  FILES_REFRESH_MS: 30000;
  syncNewer: () => void;
  HISTORY_THRESHOLD_PX: 200;
  RELOAD_DELAY_MS: 350;
  saveDraft: (key: string, value: string) => void;
  loadFiles: () => Promise<void>;
  runGuiCommand: (action: GuiAction) => Promise<undefined>;
  announcements: HTMLElement;
  tauriApi: { app?: { getVersion(): Promise<string> }; core?: { invoke<T>(command: string): Promise<T> } } | undefined;
}

export function createStore(deps: ClientDeps): ClientContext {
  return { ...deps, store: {} as SharedStore } as ClientContext;
}
