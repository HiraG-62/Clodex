import { createCommandExecutor, type CommandRunnerOptions } from "../cli/command-runner.js";

export const PROCESS_OUTPUT_LINES = 200;
const MS_PER_SECOND = 1000;

export interface ManagedProcess {
  id: number;
  command: string;
  status: "running" | "exited" | "stopped";
  exitCode?: number;
  startedAt: number;
  endedAt?: number;
}

export type ProcessManager = ReturnType<typeof createProcessManager>;

export const createProcessManager = ({ cwd, print, now = Date.now, onChange = () => {}, ...options }: CommandRunnerOptions & { onChange?: () => void }) => {
  const execute = createCommandExecutor(options);
  const entries = new Map<number, { process: ManagedProcess; lines: string[]; handle?: ReturnType<typeof execute> }>();
  let nextId = 1;

  const start = (command: string): number => {
    const id = nextId++;
    const process: ManagedProcess = { id, command, status: "running", startedAt: now() };
    const entry: { process: ManagedProcess; lines: string[]; handle?: ReturnType<typeof execute> } = { process, lines: [] };
    entries.set(id, entry);
    const append = (line: string) => {
      entry.lines.push(line);
      if (entry.lines.length > PROCESS_OUTPUT_LINES) entry.lines.shift();
    };
    print(`#${id} started: ${command}`);
    entry.handle = execute(command, typeof cwd === "function" ? cwd() : cwd, append, ({ code, stopped, error }) => {
      process.status = stopped ? "stopped" : "exited";
      process.endedAt = now();
      if (code !== null) process.exitCode = code;
      if (error) append(`error: ${error}`);
      const elapsed = ((process.endedAt - process.startedAt) / MS_PER_SECOND).toFixed(1);
      print(`#${id} ${stopped ? "stopped" : `exit ${code}`} (${elapsed}s): ${command}`);
      onChange();
    });
    onChange();
    return id;
  };
  const kill = (id: number): boolean => entries.get(id)?.handle?.stop() ?? false;
  const stopAll = () => { for (const id of entries.keys()) kill(id); };
  return {
    start, kill, stopAll,
    list: (): ManagedProcess[] => [...entries.values()].map(({ process }) => ({ ...process })),
    output: (id: number): string[] | undefined => {
      const entry = entries.get(id);
      return entry ? [...entry.lines] : undefined;
    },
  };
};
