import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeOperationScheduler } from "../../src/interaction/RuntimeOperationScheduler.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

test("does not abort a started interaction when a filesystem refresh is requested", async () => {
  const action = deferred<void>();
  const events: string[] = [];
  let interactionSignal: AbortSignal | undefined;
  const scheduler = new RuntimeOperationScheduler<string>({
    debounceMs: 0,
    performInteraction: async (context, perform) => {
      interactionSignal = context.signal;
      await perform();
    },
    capture: (context) => {
      events.push(`capture:${context.kind}`);
      return context.kind;
    },
    commit: (value) => {
      events.push(`commit:${value}`);
    },
  });

  scheduler.enqueueInteraction("tap", async () => {
    events.push("action:start");
    await action.promise;
    events.push("action:end");
  });
  scheduler.requestRefresh("filesystem-write");

  assert.equal(scheduler.state, "interacting");
  assert.equal(interactionSignal?.aborted, false);
  assert.equal(scheduler.snapshot().hasPendingRefresh, true);

  action.resolve();
  await settle();

  assert.deepEqual(events, [
    "action:start",
    "action:end",
    "capture:tap",
    "commit:tap",
    "capture:code-refresh",
    "commit:code-refresh",
  ]);
  assert.equal(scheduler.state, "idle");
});

test("runs queued interactions in FIFO order before an already-pending source refresh", async () => {
  const firstAction = deferred<void>();
  const events: string[] = [];
  const scheduler = new RuntimeOperationScheduler<string>({
    debounceMs: 0,
    capture: (context) => {
      events.push(`capture:${context.kind}`);
      return context.kind;
    },
    commit: (value) => {
      events.push(`commit:${value}`);
    },
  });

  scheduler.enqueueInteraction("tap", async () => {
    events.push("action:tap:start");
    await firstAction.promise;
    events.push("action:tap:end");
  });
  scheduler.enqueueInteraction("scroll", () => {
    events.push("action:scroll");
  });
  scheduler.requestRefresh("source-change");

  firstAction.resolve();
  await settle();

  assert.deepEqual(events, [
    "action:tap:start",
    "action:tap:end",
    "capture:tap",
    "commit:tap",
    "action:scroll",
    "capture:scroll",
    "commit:scroll",
    "capture:code-refresh",
    "commit:code-refresh",
  ]);
  assert.equal(scheduler.snapshot().pendingInteractions, 0);
  assert.equal(scheduler.state, "idle");
});

test("suppresses an invalidated capture and accepts a fresh lifecycle capture", async () => {
  const staleCapture = deferred<string>();
  const commits: string[] = [];
  const errors: unknown[] = [];
  let firstSignal: AbortSignal | undefined;
  let captures = 0;
  const scheduler = new RuntimeOperationScheduler<string>({
    debounceMs: 0,
    capture: (context) => {
      captures += 1;
      if (captures === 1) {
        firstSignal = context.signal;
        return staleCapture.promise;
      }
      return "fresh";
    },
    commit: (value) => {
      commits.push(value);
    },
    onError: (error) => {
      errors.push(error);
    },
  });

  scheduler.requestImmediateRefresh("initial");
  await settle();
  scheduler.invalidate();
  assert.equal(firstSignal?.aborted, true);

  staleCapture.resolve("stale");
  await settle();
  scheduler.requestImmediateRefresh("reconnected");
  await settle();

  assert.deepEqual(commits, ["fresh"]);
  assert.deepEqual(errors, []);
  assert.equal(captures, 2);
  assert.equal(scheduler.state, "idle");
});

test("reports a current operation error and continues draining queued work", async () => {
  const events: string[] = [];
  const errors: string[] = [];
  let captures = 0;
  const scheduler = new RuntimeOperationScheduler<string>({
    debounceMs: 0,
    capture: () => {
      captures += 1;
      if (captures === 1) {
        throw new Error("runtime compile failed");
      }
      return "second-frame";
    },
    commit: (value) => {
      events.push(`commit:${value}`);
    },
    onError: (error) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  });

  scheduler.enqueueInteraction("tap", () => {
    events.push("action:first");
  });
  scheduler.enqueueInteraction("back", () => {
    events.push("action:second");
  });
  await settle();

  assert.deepEqual(errors, ["runtime compile failed"]);
  assert.deepEqual(events, ["action:first", "action:second", "commit:second-frame"]);
  assert.equal(scheduler.state, "idle");
});

test("bounds a non-cooperative runtime action and drains the next operation", async () => {
  const events: string[] = [];
  const errors: string[] = [];
  const scheduler = new RuntimeOperationScheduler<string>({
    debounceMs: 0,
    operationTimeoutMs: 100,
    capture: (context) => {
      events.push(`capture:${context.kind}`);
      return context.kind;
    },
    commit: (value) => {
      events.push(`commit:${value}`);
    },
    onError: (error) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  });

  scheduler.enqueueInteraction("tap", () => new Promise<void>(() => undefined));
  scheduler.enqueueInteraction("back", () => {
    events.push("action:back");
  });

  await new Promise<void>((resolve) => setTimeout(resolve, 140));
  await settle();

  assert.match(errors[0] ?? "", /tap operation timed out/i);
  assert.deepEqual(events, ["action:back", "capture:back", "commit:back"]);
  assert.equal(scheduler.state, "idle");
});
