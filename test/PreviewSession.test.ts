import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AutomatorClient,
  type AutomatorElement,
  type AutomatorPage,
  type AutomatorRuntime,
} from "../src/devtools/AutomatorClient";
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

  public async currentPage(): Promise<AutomatorPage> {
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
  public notices: string[] = [];

  public updateState(state: PreviewViewState): void {
    this.states.push(state);
  }

  public showPreview(image: PreviewImage): void {
    this.images.push(image);
  }

  public showError(message: string): void {
    this.errors.push(message);
  }

  public showNotice(message: string): void {
    this.notices.push(message);
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

const VALID_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

class InteractiveRuntime implements AutomatorRuntime {
  public path = "pages/index/index";
  public tapCalls = 0;
  public inputValues: string[] = [];
  public scrollTops: number[] = [];
  public navigateBackCalls = 0;
  public readonly element: AutomatorElement;

  public constructor(tagName = "button") {
    this.element = {
      tagName,
      size: async () => ({ width: 1, height: 1 }),
      offset: async () => ({ left: 0, top: 0, width: 1, height: 1 }),
      tap: async () => {
        this.tapCalls += 1;
      },
      input: async (value: string) => {
        this.inputValues.push(value);
      },
    };
  }

  public async currentPage(): Promise<AutomatorPage> {
    return {
      path: this.path,
      $$: async (_selector: string) => [this.element],
    };
  }

  public async pageStack() {
    return [{ path: this.path }];
  }

  public async systemInfo() {
    return { windowWidth: 1, windowHeight: 1 };
  }

  public async navigateBack() {
    this.navigateBackCalls += 1;
    this.path = "pages/back/index";
    return { path: this.path };
  }

  public async pageScrollTo(scrollTop: number): Promise<void> {
    this.scrollTops.push(scrollTop);
  }

  public async screenshot() {
    return VALID_PNG;
  }

  public disconnect(): void {
    // No-op fake runtime.
  }
}

class NoSelectorRuntime extends InteractiveRuntime {
  public override async currentPage(): Promise<AutomatorPage> {
    return { path: this.path };
  }
}

function createInteractiveSession(runtime: AutomatorRuntime): { session: InstanceType<typeof PreviewSession>; consumer: FakeConsumer } {
  const controller = new DevToolsController({
    factory: { launch: async () => runtime, connect: async () => runtime },
    launchDevTools: false,
  });
  const session = new PreviewSession({
    settings,
    controller,
    client: new AutomatorClient({ captureDelayMs: 0, maxAttempts: 1, wait: async () => undefined }),
  });
  const consumer = new FakeConsumer();
  session.attachConsumer(consumer);
  return { session, consumer };
}

async function settleSession(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await flushPromises();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
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

test("ignores an interaction bound to an older preview generation", async () => {
  const runtime = new InteractiveRuntime();
  const { session, consumer } = createInteractiveSession(runtime);
  await session.start("/project");
  await settleSession();

  const latest = consumer.images.at(-1);
  assert.ok(latest);
  const operation = session.handleInteraction({
    type: "tap",
    generation: latest.generation + 1,
    screenshotX: 0,
    screenshotY: 0,
  });

  assert.equal(operation, undefined);
  assert.equal(runtime.tapCalls, 0);
  assert.equal(consumer.images.length, 1);
  assert.equal(consumer.notices.length, 1);
  session.dispose();
});

test("keeps the last screenshot and reports unsupported element discovery", async () => {
  const runtime = new NoSelectorRuntime();
  const { session, consumer } = createInteractiveSession(runtime);
  await session.start("/project");
  await settleSession();

  const latest = consumer.images.at(-1);
  assert.ok(latest);
  const operation = session.handleInteraction({
    type: "tap",
    generation: latest.generation,
    screenshotX: 0,
    screenshotY: 0,
  });
  assert.ok(operation);
  await settleSession();

  assert.equal(consumer.images.length, 1);
  assert.equal(consumer.errors.length, 0);
  assert.match(consumer.notices.at(-1) ?? "", /element discovery/i);
  assert.equal(session.state.state, "connected");
  session.dispose();
});

test("maps a screenshot tap to a real Automator element and captures the result", async () => {
  const runtime = new InteractiveRuntime("button");
  const { session, consumer } = createInteractiveSession(runtime);
  await session.start("/project");
  await settleSession();

  const before = consumer.images.at(-1);
  assert.ok(before);
  const operation = session.handleInteraction({
    type: "tap",
    generation: before.generation,
    screenshotX: 0,
    screenshotY: 0,
  });
  assert.ok(operation);
  await settleSession();

  assert.equal(runtime.tapCalls, 1);
  assert.equal(consumer.images.length, 2);
  assert.ok((consumer.images.at(-1)?.generation ?? 0) > before.generation);
  session.dispose();
});

test("enters typing mode for an input element and exits it explicitly", async () => {
  const runtime = new InteractiveRuntime("input");
  const { session, consumer } = createInteractiveSession(runtime);
  await session.start("/project");
  await settleSession();

  const before = consumer.images.at(-1);
  assert.ok(before);
  session.handleInteraction({
    type: "tap",
    generation: before.generation,
    screenshotX: 0,
    screenshotY: 0,
  });
  await settleSession();
  assert.equal(session.state.state, "typing");

  const typingFrame = consumer.images.at(-1);
  assert.ok(typingFrame);
  session.handleInteraction({ type: "input", generation: typingFrame.generation, value: "hello" });
  await settleSession();
  assert.deepEqual(runtime.inputValues, ["hello"]);
  assert.equal(session.state.state, "typing");

  session.exitTyping();
  assert.equal(session.state.state, "connected");
  session.dispose();
});

test("preserves rapid input events accepted from one displayed typing frame", async () => {
  const runtime = new InteractiveRuntime("input");
  const { session, consumer } = createInteractiveSession(runtime);
  await session.start("/project");
  await settleSession();

  const before = consumer.images.at(-1);
  assert.ok(before);
  session.handleInteraction({
    type: "tap",
    generation: before.generation,
    screenshotX: 0,
    screenshotY: 0,
  });
  await settleSession();

  const typingFrame = consumer.images.at(-1);
  assert.ok(typingFrame);
  // Browser input events can arrive faster than an Automator input + capture
  // cycle. Both messages were valid for this displayed frame and must run in
  // order even though the first one publishes a newer screenshot.
  assert.ok(session.handleInteraction({ type: "input", generation: typingFrame.generation, value: "h" }));
  assert.ok(session.handleInteraction({ type: "input", generation: typingFrame.generation, value: "he" }));
  await settleSession();

  assert.deepEqual(runtime.inputValues, ["h", "he"]);
  assert.equal(session.state.state, "typing");
  session.dispose();
});

test("back navigation updates the current page before the next capture", async () => {
  const runtime = new InteractiveRuntime();
  const { session, consumer } = createInteractiveSession(runtime);
  await session.start("/project");
  await settleSession();

  assert.ok(session.back());
  await settleSession();

  assert.equal(runtime.navigateBackCalls, 1);
  assert.equal(consumer.images.at(-1)?.pagePath, "pages/back/index");
  session.dispose();
});
