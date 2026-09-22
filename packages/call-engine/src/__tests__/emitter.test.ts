import { describe, expect, it, vi } from "vitest";
import { Emitter } from "../emitter";

describe("Emitter", () => {
  it("subscribes, unsubscribes and isolates handler errors", () => {
    const onErr = vi.fn();
    const e = new Emitter<{ x: number }>(onErr);
    const seen: number[] = [];
    e.on("x", () => {
      throw new Error("boom");
    });
    const off = e.on("x", (v) => seen.push(v));
    e.emit("x", 1);
    off();
    e.emit("x", 2);
    expect(seen).toEqual([1]);
    expect(onErr).toHaveBeenCalledTimes(2);
  });
});
