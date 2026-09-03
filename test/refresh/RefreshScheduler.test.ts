import assert from "node:assert/strict";
import test from "node:test";

import {
  RefreshScheduler,
  type RefreshClock,
  type RefreshContext,
} from "../../src/refresh/RefreshScheduler.js";

interface ScheduledTask {
  readonly dueAt: number;
  readonly callback: () => void;
}

class FakeClock implements RefreshClock {
  private currentTime = 0;
  private nextTaskId = 1;
  private readonly tasks = new Map<number, ScheduledTask>();

  public now(): number {
    return this.currentTime;
  }

  public setTimeout(callback: () => void, delayMs: number): number {
    const taskId = this.nextTaskId++;
    this.tasks.set(taskId, { dueAt: this.currentTime + delayMs, callback });
    return taskId;
  }

  public clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  public advanceBy(durationMs: number): void {
    const targetTime = this.currentTime + durationMs;

    while (true) {
      const dueTask = [...this.tasks.entries()]
        .filter(([, task]) => task.dueAt <= targetTime)
        .sort(([leftId, leftTask], [rightId, rightTask]) =>
          leftTask.dueAt - rightTask.dueAt || leftId - rightId,
        )[0];
      if (!dueTask) {
        break;
      }

      const [taskId, task] = dueTask;
      this.tasks.delete(taskId);
      this.currentTime = task.dueAt;
      task.callback();
    }

    this.currentTime = targetTime;
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
    reject: (error) => rejectPromise?.(error),
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("debounces a burst and coalesces its reasons into one latest refresh", async () => {
  const clock = new FakeClock();
  const calls: RefreshContext[] = [];
  const commits: string[] = [];
  const scheduler = new RefreshScheduler<string>({
    debounceMs: 20,
    clock,
    perform: (context) => {
      calls.push(context);
      return `preview-${context.generation}`;
    },
    commit: (result) => {
      commits.push(result);
    },
  });

  scheduler.request("save");
  clock.advanceBy(10);
  scheduler.request("filesystem");
  clock.advanceBy(19);
  assert.equal(calls.length, 0);

  clock.advanceBy(1);
  await flushPromises();

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.generation, 2);
  assert.equal(calls[0]?.requestedAt, 10);
  assert.deepEqual(calls[0]?.reasons, ["save", "filesystem"]);
  assert.deepEqual(commits, ["preview-2"]);
  assert.equal(scheduler.state, "idle");
});

test("serializes a trailing refresh and suppresses a stale result", async () => {
  const clock = new FakeClock();
  const first = deferred<string>();
  const second = deferred<string>();
  const calls: RefreshContext[] = [];
  const commits: string[] = [];
  let activeCount = 0;
  let greatestActiveCount = 0;
  const scheduler = new RefreshScheduler<string>({
    debounceMs: 10,
    clock,
    perform: (context) => {
      calls.push(context);
      activeCount += 1;
      greatestActiveCount = Math.max(greatestActiveCount, activeCount);
      const work = calls.length === 1 ? first.promise : second.promise;
      return work.finally(() => {
        activeCount -= 1;
      });
    },
    commit: (result) => {
      commits.push(result);
    },
  });

  scheduler.requestImmediate("manual");
  assert.equal(calls.length, 1);
  scheduler.request("wxml");
  scheduler.request("wxss");
  scheduler.request("js");
  assert.equal(calls[0]?.signal.aborted, true);
  assert.equal(calls.length, 1);

  first.resolve("stale-preview");
  await flushPromises();
  assert.deepEqual(commits, []);
  assert.equal(scheduler.state, "debouncing");

  clock.advanceBy(10);
  assert.equal(calls.length, 2);
  assert.equal(greatestActiveCount, 1);
  assert.equal(calls[1]?.generation, 4);
  assert.deepEqual(calls[1]?.reasons, ["wxml", "wxss", "js"]);

  second.resolve("latest-preview");
  await flushPromises();
  assert.deepEqual(commits, ["latest-preview"]);
  assert.equal(scheduler.state, "idle");
});

test("suppresses stale errors and continues with the latest queued work", async () => {
  const clock = new FakeClock();
  const first = deferred<string>();
  const calls: RefreshContext[] = [];
  const errors: unknown[] = [];
  const commits: string[] = [];
  const scheduler = new RefreshScheduler<string>({
    debounceMs: 5,
    clock,
    perform: (context) => {
      calls.push(context);
      return calls.length === 1 ? first.promise : "fresh";
    },
    commit: (result) => {
      commits.push(result);
    },
    onError: (error) => {
      errors.push(error);
    },
  });

  scheduler.requestImmediate();
  scheduler.request("external-write");
  first.reject(new Error("old runtime failure"));
  await flushPromises();

  assert.deepEqual(errors, []);
  clock.advanceBy(5);
  await flushPromises();
  assert.equal(calls.length, 2);
  assert.deepEqual(commits, ["fresh"]);
  assert.equal(scheduler.state, "idle");
});

test("reports a current error and recovers for later requests", async () => {
  const clock = new FakeClock();
  const errors: string[] = [];
  const commits: string[] = [];
  let invocation = 0;
  const scheduler = new RefreshScheduler<string>({
    clock,
    perform: () => {
      invocation += 1;
      if (invocation === 1) {
        throw new Error("runtime unavailable");
      }
      return "recovered";
    },
    commit: (result) => {
      commits.push(result);
    },
    onError: (error) => {
      errors.push((error as Error).message);
    },
  });

  scheduler.requestImmediate();
  await flushPromises();
  assert.deepEqual(errors, ["runtime unavailable"]);
  assert.equal(scheduler.state, "idle");

  scheduler.requestImmediate();
  await flushPromises();
  assert.deepEqual(commits, ["recovered"]);
  assert.equal(scheduler.state, "idle");
});

test("manual refresh bypasses idle debounce but still serializes behind active work", async () => {
  const clock = new FakeClock();
  const first = deferred<string>();
  const calls: RefreshContext[] = [];
  const scheduler = new RefreshScheduler<string>({
    debounceMs: 100,
    clock,
    perform: (context) => {
      calls.push(context);
      return calls.length === 1 ? first.promise : "second";
    },
  });

  scheduler.requestImmediate("refresh-command");
  assert.equal(calls.length, 1);
  scheduler.requestImmediate("refresh-command");
  assert.equal(calls.length, 1);

  first.resolve("first");
  await flushPromises();
  clock.advanceBy(0);
  await flushPromises();

  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.generation, 2);
});

test("dispose clears a debounce timer and makes an active completion unpublished", async () => {
  const clock = new FakeClock();
  const work = deferred<string>();
  const commits: string[] = [];
  const errors: unknown[] = [];
  let calls = 0;
  const scheduler = new RefreshScheduler<string>({
    debounceMs: 10,
    clock,
    perform: () => {
      calls += 1;
      return work.promise;
    },
    commit: (result) => {
      commits.push(result);
    },
    onError: (error) => {
      errors.push(error);
    },
  });

  scheduler.request();
  scheduler.dispose();
  clock.advanceBy(10);
  await flushPromises();
  assert.equal(calls, 0);

  const activeScheduler = new RefreshScheduler<string>({
    clock,
    perform: () => {
      calls += 1;
      return work.promise;
    },
    commit: (result) => {
      commits.push(result);
    },
    onError: (error) => {
      errors.push(error);
    },
  });
  activeScheduler.requestImmediate();
  activeScheduler.dispose();
  assert.equal(activeScheduler.state, "disposed");
  work.resolve("late-preview");
  await flushPromises();

  assert.equal(calls, 1);
  assert.deepEqual(commits, []);
  assert.deepEqual(errors, []);
});

test("normalizes invalid debounce delays while preserving an intentional zero delay", async () => {
  const clock = new FakeClock();
  const defaultDelay = new RefreshScheduler({
    debounceMs: Number.NaN,
    clock,
    perform: () => undefined,
  });
  const zeroDelayCalls: string[] = [];
  const zeroDelay = new RefreshScheduler({
    debounceMs: -10,
    clock,
    perform: () => {
      zeroDelayCalls.push("ran");
    },
  });

  assert.equal(defaultDelay.snapshot().debounceMs, 350);
  assert.equal(zeroDelay.snapshot().debounceMs, 0);
  zeroDelay.request();
  clock.advanceBy(0);
  await flushPromises();
  assert.deepEqual(zeroDelayCalls, ["ran"]);
});
