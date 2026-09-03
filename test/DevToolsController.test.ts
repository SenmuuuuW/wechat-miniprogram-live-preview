import assert from "node:assert/strict";
import { test } from "node:test";

import { DevToolsController, type AutomatorFactory } from "../src/devtools/DevToolsController";
import type { AutomatorRuntime } from "../src/devtools/AutomatorClient";
import { PreviewError } from "../src/errors/PreviewError";

class FakeRuntime implements AutomatorRuntime {
  public disconnectCalls = 0;

  public async currentPage() { return { path: "pages/index/index" }; }
  public async pageStack() { return [{ path: "pages/index/index" }]; }
  public async screenshot() { return "c2NyZWVuc2hvdA=="; }
  public disconnect(): void { this.disconnectCalls += 1; }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function controllerFor(factory: AutomatorFactory): DevToolsController {
  return new DevToolsController({
    launchDevTools: true,
    locator: { locate: async () => ({ cliPath: "/fake/cli", source: "configured" }) } as never,
    factory,
  });
}

test("disconnect invalidates a pending launch and disposes its late runtime", async () => {
  const launch = deferred<AutomatorRuntime>();
  const controller = controllerFor({
    launch: async () => launch.promise,
    connect: async () => new FakeRuntime(),
  });

  const start = controller.start({ projectPath: "/project" });
  controller.disconnect({ clearLastStart: true });
  const runtime = new FakeRuntime();
  launch.resolve(runtime);

  await assert.rejects(start, /superseded by a newer request/);
  assert.equal(runtime.disconnectCalls, 1);
  assert.equal(controller.connected, false);
  await assert.rejects(() => controller.reconnect(), (error: unknown) =>
    error instanceof PreviewError && error.code === "project-not-found",
  );
});

test("a newer start owns the runtime when an older launch resolves later", async () => {
  const first = deferred<AutomatorRuntime>();
  const second = deferred<AutomatorRuntime>();
  let calls = 0;
  const controller = controllerFor({
    launch: async () => {
      calls += 1;
      return calls === 1 ? first.promise : second.promise;
    },
    connect: async () => new FakeRuntime(),
  });

  const oldStart = controller.start({ projectPath: "/old" });
  const newStart = controller.start({ projectPath: "/new" });
  const oldRuntime = new FakeRuntime();
  const newRuntime = new FakeRuntime();
  first.resolve(oldRuntime);
  second.resolve(newRuntime);

  await assert.rejects(oldStart, /superseded by a newer request/);
  await newStart;
  assert.equal(oldRuntime.disconnectCalls, 1);
  assert.equal(controller.currentRuntime, newRuntime);
  assert.equal(controller.connected, true);
});

test("classifies an expired DevTools access token as a login requirement", async () => {
  const controller = controllerFor({
    launch: async () => {
      throw new Error("INVALID_LOGIN,access_token expired");
    },
    connect: async () => new FakeRuntime(),
  });

  await assert.rejects(
    () => controller.start({ projectPath: "/project" }),
    (error: unknown) =>
      error instanceof PreviewError &&
      error.code === "login-required" &&
      error.action === "Sign in to WeChat DevTools, then run Reconnect.",
  );
  assert.equal(controller.state, "error");
});
