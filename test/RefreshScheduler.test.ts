import assert from "node:assert/strict";
import { test } from "node:test";

import { RefreshScheduler, type RefreshClock } from "../src/refresh/RefreshScheduler";

class FakeClock implements RefreshClock {
  public current = 0;
  private nextId = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  public now(): number { return this.current; }
  public setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.current + delayMs, callback });
    return id;
  }
  public clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }
  public advance(ms: number): void {
    const target = this.current + ms;
    while (true) {
      const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      this.current = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.current = target;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("coalesces a burst into one refresh with all reasons", async () => {
  const clock = new FakeClock();
  const calls: string[][] = [];
  const scheduler = new RefreshScheduler<string>({
    debounceMs: 100,
    clock,
    perform: async (context) => { calls.push([...context.reasons]); return "ok"; },
  });

  scheduler.request("save");
  clock.advance(30);
  scheduler.request("change:a");
  clock.advance(30);
  scheduler.request("change:b");
  clock.advance(100);
  await Promise.resolve();
  assert.deepEqual(calls, [["save", "change:a", "change:b"]]);
  assert.equal(scheduler.state, "idle");
});

test("serializes refreshes and commits only the newest generation", async () => {
  const clock = new FakeClock();
  const first = deferred<string>();
  const second = deferred<string>();
  const commits: string[] = [];
  let count = 0;
  const scheduler = new RefreshScheduler<string>({
    debounceMs: 10,
    clock,
    perform: () => (++count === 1 ? first.promise : second.promise),
    commit: (value) => { commits.push(value); },
  });

  scheduler.request("one");
  clock.advance(10);
  await Promise.resolve();
  scheduler.request("two");
  first.resolve("stale");
  await Promise.resolve();
  await Promise.resolve();
  clock.advance(10);
  await Promise.resolve();
  second.resolve("fresh");
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(commits, ["fresh"]);
  assert.equal(count, 2);
});

test("current failure returns to idle and allows a later request", async () => {
  const clock = new FakeClock();
  const errors: string[] = [];
  let fail = true;
  const scheduler = new RefreshScheduler<void>({
    debounceMs: 0,
    clock,
    perform: async () => { if (fail) { fail = false; throw new Error("compile failed"); } },
    onError: (error) => { errors.push(String(error)); },
  });

  scheduler.request("first");
  clock.advance(0);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(scheduler.state, "idle");
  assert.equal(errors.length, 1);
  scheduler.request("second");
  clock.advance(0);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(scheduler.state, "idle");
});

test("dispose aborts a running context and suppresses late commits", async () => {
  const clock = new FakeClock();
  const work = deferred<string>();
  const commits: string[] = [];
  let signal!: AbortSignal;
  const scheduler = new RefreshScheduler<string>({
    debounceMs: 0,
    clock,
    perform: (context) => { signal = context.signal; return work.promise; },
    commit: (value) => { commits.push(value); },
  });
  scheduler.request("start");
  clock.advance(0);
  await Promise.resolve();
  scheduler.dispose();
  work.resolve("late");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(signal.aborted, true);
  assert.deepEqual(commits, []);
  assert.equal(scheduler.state, "disposed");
});
