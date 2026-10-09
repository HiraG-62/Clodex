// 削除したソースのビルド成果物が dist に残り、GUI に同梱されるのを防ぐ
import { rmSync } from "node:fs";

rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
