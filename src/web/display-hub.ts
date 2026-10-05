// terminal に出す行を Web UI にも配る。接続時に直近の行を送れるよう保持する（DESIGN.md §17 Web UI）
export const DEFAULT_RECENT_LINES = 500;

export type LineHandler = (line: string) => void;

export class DisplayHub {
  private readonly lines: string[] = [];
  private readonly handlers = new Set<LineHandler>();

  constructor(private readonly limit = DEFAULT_RECENT_LINES) {}

  publish(line: string): void {
    this.lines.push(line);
    if (this.lines.length > this.limit) this.lines.splice(0, this.lines.length - this.limit);
    for (const handler of [...this.handlers]) {
      try {
        handler(line);
      } catch {
        // 切断済みのクライアント等。他のクライアントへの配信は続ける
      }
    }
  }

  recent(): string[] {
    return [...this.lines];
  }

  subscribe(handler: LineHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}
