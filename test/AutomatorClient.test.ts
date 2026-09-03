import assert from "node:assert/strict";
import { test } from "node:test";

import { AutomatorClient, type AutomatorRuntime } from "../src/devtools/AutomatorClient";
import { PreviewError } from "../src/errors/PreviewError";

class FakeRuntime implements AutomatorRuntime {
  public disconnectCalls = 0;
  public screenshots: Array<string | void> = [];
  public currentPageValue = { path: "pages/index/index" };
  public pageStackValue = [{ path: "pages/index/index" }];
  public error: Error | undefined;

  public async currentPage() {
    if (this.error) {
      throw this.error;
    }
    return this.currentPageValue;
  }

  public async pageStack() {
    if (this.error) {
      throw this.error;
    }
    return this.pageStackValue;
  }

  public async screenshot() {
    if (this.error) {
      throw this.error;
    }
    return this.screenshots.length > 1 ? this.screenshots.shift() : this.screenshots[0];
  }

  public disconnect(): void {
    this.disconnectCalls += 1;
  }
}

test("normalizes data-URI and wrapped base64 while waiting for a stable frame", async () => {
  const runtime = new FakeRuntime();
  runtime.screenshots = ["data:image/png;base64,Zmly\n c3Q=", "ZmVj b25k", "ZmVj b25k"];
  const client = new AutomatorClient({ captureDelayMs: 0, maxAttempts: 3, wait: async () => undefined });

  client.attach(runtime);
  const result = await client.capture();

  assert.equal(result.data, "ZmVjb25k");
  assert.equal(result.pagePath, "pages/index/index");
  assert.deepEqual(result.pageStack, ["pages/index/index"]);
  assert.equal(result.attempts, 3);
});

test("classifies a closed automator socket as a reconnectable runtime error", async () => {
  const runtime = new FakeRuntime();
  runtime.error = new Error("Connection closed, check if wechat web devTools is still running");
  const client = new AutomatorClient({ captureDelayMs: 0, wait: async () => undefined });
  client.attach(runtime);

  await assert.rejects(
    () => client.capture(),
    (error: unknown) => error instanceof PreviewError && error.code === "runtime-disconnected",
  );
});

test("rejects an empty screenshot payload", async () => {
  const runtime = new FakeRuntime();
  runtime.screenshots = ["data:image/png;base64,"];
  const client = new AutomatorClient({ captureDelayMs: 0, wait: async () => undefined });
  client.attach(runtime);

  await assert.rejects(
    () => client.capture(),
    (error: unknown) => error instanceof PreviewError && error.code === "screenshot-failed",
  );
});
