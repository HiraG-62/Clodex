import { describe, expect, it } from "vitest";
import { DisplayHub } from "./display-hub.js";

describe("DisplayHub", () => {
  it("publish した行を購読者に配り、直近の行を保持する", () => {
    const hub = new DisplayHub(3);
    const received: string[] = [];
    hub.subscribe((line) => received.push(line));
    ["a", "b", "c", "d"].forEach((l) => hub.publish(l));
    expect(received).toEqual(["a", "b", "c", "d"]);
    expect(hub.recent()).toEqual(["b", "c", "d"]);
  });

  it("unsubscribe 後は届かない", () => {
    const hub = new DisplayHub();
    const received: string[] = [];
    const unsubscribe = hub.subscribe((line) => received.push(line));
    unsubscribe();
    hub.publish("x");
    expect(received).toEqual([]);
  });

  it("購読者の例外は他の購読者に波及しない", () => {
    const hub = new DisplayHub();
    const received: string[] = [];
    hub.subscribe(() => { throw new Error("broken client"); });
    hub.subscribe((line) => received.push(line));
    expect(() => hub.publish("x")).not.toThrow();
    expect(received).toEqual(["x"]);
  });
});
