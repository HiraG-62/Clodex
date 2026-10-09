// スマホへの通知（DESIGN.md §28 スマホへの通知（Web Push））。鍵と購読を ~/.clodex/push に持ち、見えていない端末にだけ送る
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import webpush from "web-push";
import { z } from "zod";

const VAPID_SUBJECT = "https://github.com/HiraG-62/Clodex";
const VAPID_FILE = "vapid.json";
const SUBSCRIPTIONS_FILE = "subscriptions.json";
const ID_LENGTH = 16;
const GONE_STATUSES: ReadonlySet<number> = new Set([404, 410]);

const subscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});
const vapidSchema = z.object({ publicKey: z.string().min(1), privateKey: z.string().min(1) });

export type PushSubscription = z.infer<typeof subscriptionSchema>;
export interface Vapid {
  subject: string;
  publicKey: string;
  privateKey: string;
}
export type PushSend = (subscription: PushSubscription, payload: string, vapid: Vapid) => Promise<void>;
export interface PushNotification {
  title: string;
  body: string;
}

const sendWebPush: PushSend = async (subscription, payload, { subject, publicKey, privateKey }) => {
  await webpush.sendNotification(subscription, payload, { vapidDetails: { subject, publicKey, privateKey } });
};

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

export class PushService {
  private vapid: Vapid | undefined;
  private subscriptions: Array<PushSubscription & { id: string }>;
  // 購読の id ごとの、つながっている画面の接続と見えているか
  private readonly streams = new Map<string, Set<{ visible: boolean }>>();

  constructor(
    private readonly dir: string,
    private readonly send: PushSend = sendWebPush,
  ) {
    const saved = z.array(subscriptionSchema.extend({ id: z.string() })).safeParse(readJson(join(dir, SUBSCRIPTIONS_FILE)));
    this.subscriptions = saved.success ? saved.data : [];
  }

  publicKey(): string {
    return this.keys().publicKey;
  }

  has(id: string): boolean {
    return this.subscriptions.some(entry => entry.id === id);
  }

  subscribe(input: unknown): string | undefined {
    const parsed = subscriptionSchema.safeParse(input);
    if (!parsed.success) return undefined;
    const id = createHash("sha256").update(parsed.data.endpoint).digest("hex").slice(0, ID_LENGTH);
    this.subscriptions = [...this.subscriptions.filter(entry => entry.id !== id), { id, ...parsed.data }];
    this.save();
    return id;
  }

  unsubscribe(id: string): void {
    this.subscriptions = this.subscriptions.filter(entry => entry.id !== id);
    this.save();
  }

  connect(id: string, visible: boolean): { close(): void } {
    const stream = { visible };
    const streams = this.streams.get(id) ?? new Set();
    streams.add(stream);
    this.streams.set(id, streams);
    return {
      close: () => {
        streams.delete(stream);
      },
    };
  }

  setVisible(id: string, visible: boolean): void {
    for (const stream of this.streams.get(id) ?? []) stream.visible = visible;
  }

  async notify(notification: PushNotification): Promise<void> {
    const payload = JSON.stringify(notification);
    const targets = this.subscriptions.filter(entry => ![...(this.streams.get(entry.id) ?? [])].some(stream => stream.visible));
    const vapid = this.keys();
    const gone = new Set<string>();
    await Promise.all(
      targets.map(async ({ id, ...subscription }) => {
        try {
          await this.send(subscription, payload, vapid);
        } catch (error) {
          const status = (error as { statusCode?: unknown }).statusCode;
          if (typeof status === "number" && GONE_STATUSES.has(status)) gone.add(id);
        }
      }),
    );
    if (!gone.size) return;
    this.subscriptions = this.subscriptions.filter(entry => !gone.has(entry.id));
    this.save();
  }

  private keys(): Vapid {
    if (this.vapid) return this.vapid;
    const path = join(this.dir, VAPID_FILE);
    const saved = vapidSchema.safeParse(readJson(path));
    const keys = saved.success ? saved.data : webpush.generateVAPIDKeys();
    if (!saved.success) {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(path, JSON.stringify(keys));
    }
    this.vapid = { subject: VAPID_SUBJECT, ...keys };
    return this.vapid;
  }

  private save(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, SUBSCRIPTIONS_FILE), JSON.stringify(this.subscriptions));
  }
}
