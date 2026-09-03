import assert from "node:assert/strict";
import { test } from "node:test";

import { AutomatorClient, type AutomatorRuntime } from "../src/devtools/AutomatorClient";
import { DevToolsController, type AutomatorFactory } from "../src/devtools/DevToolsController";
import type { PreviewSession as PreviewSessionClass } from "../src/session/PreviewSession";
import type { PreviewConsumer, PreviewImage, PreviewViewState } from "../src/preview/PreviewProvider";
import type { PreviewSettings } from "../src/config/settings";

interface RuntimeListener {
  (payload: unknown): void;
}

class FakeRuntime implements AutomatorRuntime {
  public disconnectCalls = 0;
  private readonly listeners = new Map<"console" | "exception", RuntimeListener[]>();

  public async currentPage() {
    return { path: "pages/index/index" };
  }

  public async pageStack() {
    return [{ path: "pages/index/index" }];
  }

  public async screenshot() {
    return "c2NyZWVuc2hvdA==";
  }

  public disconnect(): void {
    this.disconnectCalls += 1;
  }

  public on(event: "console" | "exception", listener: RuntimeListener): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  public emit(event: "console" | "exception", payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload);
    }
  }
}

class FakeConsumer implements PreviewConsumer {
  public states: PreviewViewState[] = [];
  public images: PreviewImage[] = [];
  public errors: string[] = [];

  public updateState(state: PreviewViewState): void {
    this.states.push(state);
  }

  public showPreview(image: PreviewImage): void {
    this.images.push(image);
  }

  public showError(message: string): void {
    this.errors.push(message);
  }

  public dispose(): void {
    // No-op fake consumer.
  }
}

function loadPreviewSession(): typeof PreviewSessionClass {
  // PreviewSession only needs vscode types at runtime, but the extension host
  // module is unavailable in the plain Node test process.
  const moduleApi = require("node:module") as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = moduleApi._load;
  moduleApi._load = (request, parent, isMain) => {
    if (request === "vscode") {
      return {};
    }
    return originalLoad(request, parent, isMain);
  };
  try {
    return (require("../src/session/PreviewSession") as { PreviewSession: typeof PreviewSessionClass }).PreviewSession;
  } finally {
    moduleApi._load = originalLoad;
  }
}

const PreviewSession = loadPreviewSession();

const settings: PreviewSettings = {
  devtoolsPath: undefined,
  projectPath: undefined,
  autoRefresh: false,
  refreshDelay: 0,
  automatorPort: 9420,
  launchDevTools: false,
  autoReconnect: false,
  captureDelay: 0,
  maxRefreshRetries: 1,
};

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("ignores a runtime exception emitted by a superseded project", async () => {
  const firstRuntime = new FakeRuntime();
  const secondRuntime = new FakeRuntime();
  let connectCalls = 0;
  const factory: AutomatorFactory = {
    launch: async () => firstRuntime,
    connect: async () => (connectCalls++ === 0 ? firstRuntime : secondRuntime),
  };
  const controller = new DevToolsController({ factory, launchDevTools: false });
  const session = new PreviewSession({
    settings,
    controller,
    client: new AutomatorClient({ captureDelayMs: 0, maxAttempts: 1, wait: async () => undefined }),
  });

  await session.start("/project-a");
  await session.start("/project-b");
  await flushPromises();

  firstRuntime.emit("exception", { message: "stale project failure" });

  assert.equal(session.currentProjectPath, "/project-b");
  assert.equal(session.state.state, "connected");
  assert.equal(session.state.error, undefined);
  assert.equal(firstRuntime.disconnectCalls, 1);

  session.dispose();
});

test("replays the latest preview to consumers attached after capture", async () => {
  const runtime = new FakeRuntime();
  const controller = new DevToolsController({
    factory: { launch: async () => runtime, connect: async () => runtime },
    launchDevTools: false,
  });
  const session = new PreviewSession({
    settings,
    controller,
    client: new AutomatorClient({ captureDelayMs: 0, maxAttempts: 1, wait: async () => undefined }),
  });

  await session.start("/project");
  await flushPromises();

  const consumer = new FakeConsumer();
  const registration = session.attachConsumer(consumer);
  assert.equal(consumer.images.length, 1);
  assert.equal(consumer.images[0]?.pagePath, "pages/index/index");
  assert.equal(consumer.images[0]?.data, "c2NyZWVuc2hvdA==");

  registration.dispose();
  session.stop();
  const lateConsumer = new FakeConsumer();
  session.attachConsumer(lateConsumer);
  assert.equal(lateConsumer.images.length, 0);

  session.dispose();
});
