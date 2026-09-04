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

test("adapts Automator CSS-pixel geometry for real element hit testing", async () => {
  const runtime: AutomatorRuntime = {
    currentPage: async () => ({
      path: "pages/index/index",
      $$: async () => [{
        tagName: "button",
        offset: async () => ({ left: "12.5px", top: "7px" }),
        size: async () => ({ width: "140px", height: "44.25px" }),
        tap: async () => undefined,
      }],
    }),
    pageStack: async () => [],
    screenshot: async () => undefined,
    disconnect: () => undefined,
  };
  const client = new AutomatorClient();
  client.attach(runtime);

  const page = await client.currentInteractionPage();
  const elements = await page?.$$("*");

  assert.deepEqual(elements?.map((element) => element.rect), [{
    left: 12.5,
    top: 7,
    width: 140,
    height: 44.25,
  }]);
});

test("does not turn arbitrary CSS text into a runtime coordinate", async () => {
  const runtime: AutomatorRuntime = {
    currentPage: async () => ({
      path: "pages/index/index",
      $$: async () => [{
        tagName: "view",
        offset: async () => ({ left: "calc(10px + 2px)", top: "0px" }),
        size: async () => ({ width: "100px", height: "20px" }),
        tap: async () => undefined,
      }],
    }),
    pageStack: async () => [],
    screenshot: async () => undefined,
    disconnect: () => undefined,
  };
  const client = new AutomatorClient();
  client.attach(runtime);

  const page = await client.currentInteractionPage();
  assert.deepEqual(await page?.$$("*"), []);
});

test("classifies a bounded capture timeout as screenshot failure while the socket remains open", async () => {
  const runtime: AutomatorRuntime = {
    currentPage: () => new Promise(() => undefined),
    pageStack: () => new Promise(() => undefined),
    screenshot: () => new Promise(() => undefined),
    disconnect: () => undefined,
  };
  const client = new AutomatorClient({ captureTimeoutMs: 500, captureDelayMs: 0, maxAttempts: 1 });
  client.attach(runtime);

  await assert.rejects(
    () => client.capture(),
    (error: unknown) => error instanceof PreviewError && error.code === "screenshot-failed",
  );
});

test("bounds current page and element operations independently", async () => {
  const runtime: AutomatorRuntime = {
    currentPage: () => new Promise(() => undefined),
    pageStack: async () => [],
    screenshot: async () => undefined,
    disconnect: () => undefined,
  };
  const client = new AutomatorClient({ operationTimeoutMs: 100 });
  client.attach(runtime);

  await assert.rejects(
    () => client.currentInteractionPage(),
    (error: unknown) => error instanceof PreviewError && error.code === "interaction-unsupported",
  );

  const elementRuntime: AutomatorRuntime = {
    currentPage: async () => ({
      path: "pages/index/index",
      $$: async () => [{
        tagName: "button",
        offset: async () => ({ left: 0, top: 0, width: 10, height: 10 }),
        size: async () => ({ width: 10, height: 10 }),
        tap: () => new Promise(() => undefined),
      }],
    }),
    pageStack: async () => [],
    screenshot: async () => undefined,
    disconnect: () => undefined,
  };
  client.attach(elementRuntime);
  const page = await client.currentInteractionPage();
  const elements = await page?.$$("*");
  assert.equal(elements?.length, 1);
  await assert.rejects(
    () => elements![0]!.tap(),
    (error: unknown) => error instanceof PreviewError && error.code === "interaction-unsupported",
  );
});
