import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { aggregateTaskMetrics, type TaskMetricRecord } from "../src/coordinator/task-metrics-summary.ts";

interface Message {
  id: string;
  type: string;
  taskId: string;
  from: string;
  to: string;
  replyTo?: string;
  fresh?: boolean;
  status?: string;
  createdAt?: string;
}
interface LogEvent {
  kind: string;
  at: string;
  agent?: string;
  message?: Message;
  event?: { type: string; sessionId?: string; inputTotal?: number; total?: number; tokens?: number; result?: { status: string } };
}
interface Source {
  project: string;
  conversationId: string;
  events: LogEvent[];
}
const CONTEXT_THRESHOLD = 150_000;
const DELIVERED_TYPES = new Set(["DELEGATE", "REVIEW_REQUEST", "QUESTION", "ANSWER", "RESULT", "ISSUE", "ACK"]);
const ratio = (count: number, total: number) => (total ? count / total : null);
export const percentile = (values: number[], p: number): number | null => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  return sorted[lower]! + (sorted[Math.ceil(index)]! - sorted[lower]!) * (index - lower);
};

export const analyzeBaseline = (sources: Source[]) => {
  const records: TaskMetricRecord[] = [];
  const projectData = new Map<string, { messages: Message[]; contexts: number[]; resultInputs: number[] }>();
  let turns = 0;
  let missingTokenTurns = 0;
  let firstAt: string | undefined;
  let lastAt: string | undefined;
  for (const source of sources) {
    const data = projectData.get(source.project) ?? { messages: [], contexts: [], resultInputs: [] };
    projectData.set(source.project, data);
    const queues = new Map<string, Message[]>();
    const humans = new Set<string>();
    const totals = new Map<string, number>();
    const contexts = new Map<string, number>();
    const sessions = new Map<string, string>();
    const active = new Map<string, { startedAt: string; before: number; message?: Message; tokenObserved: boolean }>();
    const conversationId = `${source.project}/${source.conversationId}`;
    for (const event of source.events) {
      firstAt = !firstAt || event.at < firstAt ? event.at : firstAt;
      lastAt = !lastAt || event.at > lastAt ? event.at : lastAt;
      if (event.kind === "message" && event.message) {
        const message = event.message;
        data.messages.push(message);
        records.push({ ...message, kind: "message", conversationId, at: event.at } as TaskMetricRecord);
        if (DELIVERED_TYPES.has(message.type)) queues.set(message.to, [...(queues.get(message.to) ?? []), message]);
      }
      const agent = event.agent;
      if (!agent) continue;
      if (event.kind === "human") humans.add(agent);
      if (event.kind !== "agent" || !event.event) continue;
      const item = event.event;
      if (item.type === "session" && item.sessionId !== sessions.get(agent)) {
        sessions.set(agent, item.sessionId ?? "");
        totals.set(agent, 0);
        contexts.delete(agent);
        const turn = active.get(agent);
        if (turn) turn.before = 0;
      }
      if (item.type === "context") {
        if (item.inputTotal !== undefined) totals.set(agent, item.inputTotal);
        if (item.tokens !== undefined) contexts.set(agent, item.tokens);
      }
      if (item.type === "input_total" && item.total !== undefined) totals.set(agent, item.total);
      if ((item.type === "context" && item.inputTotal !== undefined) || item.type === "input_total") {
        const turn = active.get(agent);
        if (turn) turn.tokenObserved = true;
      }
      if (item.type === "turn_started") {
        const message = humans.delete(agent) ? undefined : queues.get(agent)?.shift();
        active.set(agent, { startedAt: event.at, before: totals.get(agent) ?? 0, message, tokenObserved: false });
        if (message)
          records.push({
            kind: "delivery",
            conversationId,
            taskId: message.taskId,
            messageId: message.id,
            at: event.at,
            waitMs: Math.max(0, Date.parse(event.at) - Date.parse(message.createdAt ?? event.at)),
          });
      }
      if (item.type !== "turn") continue;
      turns++;
      const context = contexts.get(agent);
      if (agent === "claude" && context !== undefined) data.contexts.push(context);
      const turn = active.get(agent);
      if (!turn) continue;
      active.delete(agent);
      const total = totals.get(agent) ?? 0;
      const inputTokens = total < turn.before ? total : total - turn.before;
      if (!turn.tokenObserved) missingTokenTurns++;
      if (turn.message?.type === "RESULT" && turn.tokenObserved) data.resultInputs.push(inputTokens);
      records.push({
        kind: "turn",
        conversationId,
        agent,
        taskId: turn.message?.taskId,
        startedAt: turn.startedAt,
        at: event.at,
        status: item.result?.status ?? "completed",
        inputTokens,
        cachedInputTokens: 0,
        outputTokens: 0,
      } as TaskMetricRecord);
    }
  }
  const combined = {
    messages: [...projectData.values()].flatMap(data => data.messages),
    contexts: [...projectData.values()].flatMap(data => data.contexts),
    resultInputs: [...projectData.values()].flatMap(data => data.resultInputs),
  };
  const projects = [...projectData, ["全体", combined] as const].map(([project, data]) => {
    const delegates = data.messages.filter(message => message.type === "DELEGATE");
    const counts = new Map(delegates.map(message => [message.id, 0]));
    const latest = new Map<string, string>();
    for (const message of data.messages) {
      if (message.type === "DELEGATE") latest.set(message.taskId, message.id);
      if (message.type !== "QUESTION") continue;
      const id = message.replyTo && counts.has(message.replyTo) ? message.replyTo : latest.get(message.taskId);
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const questionRate = (subset: Message[], minimum = 1) => ratio(subset.filter(message => (counts.get(message.id) ?? 0) >= minimum).length, subset.length);
    return {
      project,
      delegates: delegates.length,
      questionRate: questionRate(delegates),
      twoQuestionRate: questionRate(delegates, 2),
      questionsPerDelegate: ratio(data.messages.filter(message => message.type === "QUESTION").length, delegates.length),
      claudeContextMedian: percentile(data.contexts, 0.5),
      claudeOver150k: ratio(data.contexts.filter(value => value > CONTEXT_THRESHOLD).length, data.contexts.length),
      resultInputMedian: percentile(data.resultInputs, 0.5),
      freshQuestionRate: questionRate(delegates.filter(message => message.fresh === true)),
      nonFreshQuestionRate: questionRate(delegates.filter(message => message.fresh !== true)),
    };
  });
  const { tasks, unassigned } = aggregateTaskMetrics(records);
  const fields = ["turns", "inputTokens", "durationMs", "waitMs", "elapsedMs", "questions", "results", "retries"] as const;
  const distributions = fields.map(field => ({
    field,
    median: percentile(
      tasks.map(task => task[field]),
      0.5,
    ),
    p90: percentile(
      tasks.map(task => task[field]),
      0.9,
    ),
  }));
  return {
    messages: [...projectData.values()].reduce((sum, data) => sum + data.messages.length, 0),
    turns,
    missingTokenTurns,
    firstAt,
    lastAt,
    projects,
    tasks,
    distributions,
    unassignedTurns: unassigned.reduce((sum, task) => sum + task.turns, 0),
    accepted: tasks.filter(task => task.accepted).length,
    firstAcceptanceRate: ratio(tasks.filter(task => task.firstAccepted).length, tasks.filter(task => task.accepted).length),
  };
};

export const formatBaseline = (result: ReturnType<typeof analyzeBaseline>): string => {
  const number = (value: number | null) => (value === null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 2 }));
  const percent = (value: number | null) => (value === null ? "—" : `${number(value * 100)}%`);
  return [
    `期間: ${result.firstAt} ～ ${result.lastAt}`,
    `message: ${result.messages} 件 / ターン: ${result.turns} 件 / 未割当: ${result.unassignedTurns} ターン`,
    `入力 token 欠測: ${result.missingTokenTurns} ターン（RESULT受信入力の中央値は欠測を除外）`,
    "",
    "| project | DELEGATE | 質問あり | 質問2件以上 | QUESTION/DELEGATE | Claude context 中央値 | 150k超 | RESULT受信入力 中央値 | fresh 質問率 | 非fresh 質問率 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...result.projects.map(
      p =>
        `| ${p.project} | ${p.delegates} | ${percent(p.questionRate)} | ${percent(p.twoQuestionRate)} | ${number(p.questionsPerDelegate)} | ${number(p.claudeContextMedian)} | ${percent(p.claudeOver150k)} | ${number(p.resultInputMedian)} | ${percent(p.freshQuestionRate)} | ${percent(p.nonFreshQuestionRate)} |`,
    ),
    "",
    "| task 指標 | 中央値 | p90 |",
    "|---|---:|---:|",
    ...result.distributions.map(d => `| ${d.field} | ${number(d.median)} | ${number(d.p90)} |`),
    "",
    `受入完了: ${result.accepted} / 初回受入率（受入完了を分母）: ${percent(result.firstAcceptanceRate)}`,
    "",
    "ターンと task は宛先の待ち行列から推定。人の入力は未割当。キャッシュ内訳・出力・rework は過去の記録にないため集計対象外。時間の単位は ms。欠測 token は 0 として集計。",
  ].join("\n");
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const directory = args.find(arg => !arg.startsWith("--")) ?? join(homedir(), ".clodex", "metrics-baseline", "logs");
  const from = args.find(arg => arg.startsWith("--from="))?.slice("--from=".length);
  const until = args.find(arg => arg.startsWith("--until="))?.slice("--until=".length);
  const sources: Source[] = readdirSync(directory)
    .filter(name => name.endsWith(".jsonl"))
    .sort()
    .map(name => {
      const match = /^(.*)-\d{8}-\d{6}(?:-(.*))?\.jsonl$/.exec(name);
      const events = readFileSync(join(directory, name), "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => JSON.parse(line) as LogEvent)
        .filter(event => (!from || event.at >= from) && (!until || event.at < until));
      return { project: match?.[1] ?? name, conversationId: match?.[2] ?? name, events };
    });
  const result = analyzeBaseline(sources);
  console.log(args.includes("--json") ? JSON.stringify(result, null, 2) : formatBaseline(result));
}
