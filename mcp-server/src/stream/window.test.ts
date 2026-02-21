import { describe, it, expect } from "vitest";
import { RingBuffer } from "./window.js";

describe("RingBuffer", () => {
  it("stores and retrieves items newest-first", () => {
    const buf = new RingBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    expect(buf.latest()).toEqual([3, 2, 1]);
    expect(buf.length).toBe(3);
  });

  it("wraps around at capacity", () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4); // overwrites 1
    buf.push(5); // overwrites 2

    expect(buf.length).toBe(3);
    expect(buf.latest()).toEqual([5, 4, 3]);
  });

  it("latest(n) returns at most n items", () => {
    const buf = new RingBuffer<string>(10);
    buf.push("a");
    buf.push("b");
    buf.push("c");

    expect(buf.latest(2)).toEqual(["c", "b"]);
    expect(buf.latest(10)).toEqual(["c", "b", "a"]);
  });

  it("handles empty buffer", () => {
    const buf = new RingBuffer<number>(5);
    expect(buf.latest()).toEqual([]);
    expect(buf.length).toBe(0);
  });

  it("clear resets the buffer", () => {
    const buf = new RingBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    buf.clear();
    expect(buf.length).toBe(0);
    expect(buf.latest()).toEqual([]);
  });

  it("survives many wraps", () => {
    const buf = new RingBuffer<number>(3);
    for (let i = 0; i < 100; i++) buf.push(i);
    expect(buf.length).toBe(3);
    expect(buf.latest()).toEqual([99, 98, 97]);
  });
});
