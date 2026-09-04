import { createHash } from "node:crypto";

import { PreviewError, errorMessage } from "../errors/PreviewError";
import type { RefreshContext } from "../refresh/RefreshScheduler";
import type { ResolvedElement, RuntimePage, RuntimeRect } from "../interaction/InteractionTypes";

export interface AutomatorRuntime {
  currentPage(): Promise<AutomatorPage | undefined>;
  pageStack(): Promise<readonly AutomatorPage[]>;
  systemInfo?(): Promise<{ windowWidth?: number; windowHeight?: number; [key: string]: unknown }>;
  navigateBack?(): Promise<AutomatorPage | undefined>;
  pageScrollTo?(scrollTop: number): Promise<void>;
  navigateTo?(url: string): Promise<AutomatorPage | undefined>;
  redirectTo?(url: string): Promise<AutomatorPage | undefined>;
  switchTab?(url: string): Promise<AutomatorPage | undefined>;
  evaluate?(script: Function | string, ...args: unknown[]): Promise<unknown>;
  /** Public Automator page operations are intentionally optional for old fakes. */
  screenshot(options?: { path?: string }): Promise<string | void>;
  disconnect(): void;
  close?(): Promise<void>;
  on?(event: "console" | "exception", listener: (payload: unknown) => void): this;
}

export interface AutomatorPage {
  readonly path: string;
  readonly query?: Record<string, unknown>;
  $?(selector: string): Promise<AutomatorElement | null>;
  $$?(selector: string): Promise<readonly AutomatorElement[]>;
  scrollTop?(): Promise<string | string[] | number>;
}

export interface AutomatorElement {
  readonly tagName: string;
  size?(): Promise<{ width: string | number; height: string | number }>;
  offset?(): Promise<{
    left?: string | number;
    top?: string | number;
    width?: string | number;
    height?: string | number;
    [key: string]: unknown;
  }>;
  tap(): Promise<void>;
  input?(value: string): Promise<void>;
  scrollTo?(x: number, y: number): Promise<void>;
  swipeTo?(index: number): Promise<void>;
  property?(name: string): Promise<unknown>;
  attribute?(name: string): Promise<string>;
}

export interface ScreenshotResult {
  readonly data: string;
  /** Pixel dimensions parsed from the captured PNG when the payload is valid PNG. */
  readonly screenshotSize: { readonly width: number; readonly height: number } | undefined;
  readonly pagePath: string | undefined;
  readonly pageStack: readonly string[];
  readonly capturedAt: number;
  readonly captureLatencyMs: number;
  readonly attempts: number;
}

export interface AutomatorClientOptions {
  readonly captureDelayMs?: number;
  readonly maxAttempts?: number;
  /** Bounds one Automator frame request so a wedged socket can be reconnected. */
  readonly captureTimeoutMs?: number;
  /** Bounds individual Automator interaction calls (selector, geometry, input, navigation). */
  readonly operationTimeoutMs?: number;
  readonly wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

/** Thin adapter around the public miniprogram-automator surface. */
export class AutomatorClient {
  private runtime: AutomatorRuntime | undefined;
  private readonly captureDelayMs: number;
  private readonly maxAttempts: number;
  private readonly captureTimeoutMs: number;
  private readonly operationTimeoutMs: number;
  private readonly wait: (delayMs: number, signal?: AbortSignal) => Promise<void>;

  public constructor(options: AutomatorClientOptions = {}) {
    this.captureDelayMs = normalizeInteger(options.captureDelayMs, 180, 0);
    this.maxAttempts = normalizeInteger(options.maxAttempts, 3, 1, 8);
    this.captureTimeoutMs = normalizeInteger(options.captureTimeoutMs, 8_000, 500, 30_000);
    this.operationTimeoutMs = normalizeInteger(options.operationTimeoutMs, 5_000, 100, 30_000);
    this.wait = options.wait ?? waitWithAbort;
  }

  public attach(runtime: AutomatorRuntime): void {
    this.runtime = runtime;
  }

  public get connected(): boolean {
    return this.runtime !== undefined;
  }

  public detach(): void {
    this.runtime = undefined;
  }

  public get currentRuntime(): AutomatorRuntime | undefined {
    return this.runtime;
  }

  public async systemInfo(): Promise<{ windowWidth?: number; windowHeight?: number; [key: string]: unknown }> {
    const runtime = this.requireRuntime("read runtime system information");
    if (!runtime.systemInfo) {
      return {};
    }
    return this.callOperation(() => runtime.systemInfo!(), "read runtime system information");
  }

  public async navigateBack(): Promise<AutomatorPage | undefined> {
    const runtime = this.requireRuntime("navigate back");
    if (!runtime.navigateBack) {
      throw new PreviewError("interaction-unsupported", "Back navigation is unavailable in this Automator runtime.");
    }
    return this.callOperation(() => runtime.navigateBack!(), "navigate back");
  }

  public async pageScrollTo(scrollTop: number): Promise<void> {
    const runtime = this.requireRuntime("scroll the page");
    if (!runtime.pageScrollTo) {
      throw new PreviewError("interaction-unsupported", "Page scrolling is unavailable in this Automator runtime.");
    }
    await this.callOperation(() => runtime.pageScrollTo!(scrollTop), "scroll the page");
  }

  /**
   * Adapts the public Automator page/element API to the interaction layer.
   * The adapter deliberately uses only documented operations: selector lookup,
   * offset/size geometry, tap, and input. It never synthesizes a simulator tap.
   */
  public async currentInteractionPage(): Promise<RuntimePage | undefined> {
    const runtime = this.requireRuntime("resolve a preview interaction target");
    const page = await this.callOperation(() => runtime.currentPage(), "read the current runtime page");
    return page ? adaptInteractionPage(page, (operation, action) => this.callOperation(operation, action)) : undefined;
  }

  public async navigateTo(url: string): Promise<AutomatorPage | undefined> {
    const runtime = this.requireRuntime("navigate to a page");
    if (!runtime.navigateTo) {
      throw new PreviewError("interaction-unsupported", "Navigation is unavailable in this Automator runtime.");
    }
    return this.callOperation(() => runtime.navigateTo!(url), `navigate to ${url}`);
  }

  public async redirectTo(url: string): Promise<AutomatorPage | undefined> {
    const runtime = this.requireRuntime("redirect to a page");
    if (!runtime.redirectTo) {
      throw new PreviewError("interaction-unsupported", "Navigation is unavailable in this Automator runtime.");
    }
    return this.callOperation(() => runtime.redirectTo!(url), `redirect to ${url}`);
  }

  public async switchTab(url: string): Promise<AutomatorPage | undefined> {
    const runtime = this.requireRuntime("switch tab");
    if (!runtime.switchTab) {
      throw new PreviewError("interaction-unsupported", "Tab switching is unavailable in this Automator runtime.");
    }
    return this.callOperation(() => runtime.switchTab!(url), `switch to ${url}`);
  }

  private async callOperation<T>(operation: () => Promise<T> | T, action: string): Promise<T> {
    try {
      return await withTimeout(
        Promise.resolve().then(operation),
        this.operationTimeoutMs,
        () => new PreviewError(
          "interaction-unsupported",
          `WeChat DevTools did not respond while trying to ${action}.`,
          { action: "Run Mini Program: Reconnect." },
        ),
      );
    } catch (error) {
      throw classifyOperationError(error, action);
    }
  }

  private requireRuntime(action: string): AutomatorRuntime {
    if (!this.runtime) {
      throw new PreviewError(
        "runtime-disconnected",
        `Unable to ${action} because WeChat DevTools is disconnected.`,
        { action: "Run Mini Program: Reconnect." },
      );
    }
    return this.runtime;
  }

  public async capture(context?: RefreshContext): Promise<ScreenshotResult> {
    const runtime = this.runtime;
    if (!runtime) {
      throw new PreviewError(
        "runtime-disconnected",
        "Unable to capture a preview because WeChat DevTools is disconnected.",
        { action: "Run Mini Program: Reconnect." },
      );
    }

    const startedAt = Date.now();
    let previousHash: string | undefined;
    let latestData: string | undefined;
    let latestPagePath: string | undefined;
    let latestStack: readonly string[] = [];
    let attempts = 0;

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      attempts = attempt + 1;
      const delay = attempt === 0 ? this.captureDelayMs : Math.min(800, this.captureDelayMs * 2 ** attempt);
      await this.wait(delay, context?.signal);
      throwIfAborted(context?.signal);

      let page: AutomatorPage | undefined;
      let stack: readonly AutomatorPage[];
      let screenshot: string | void;
      try {
        [page, stack, screenshot] = await withTimeout(
          Promise.all([
            runtime.currentPage(),
            runtime.pageStack(),
            runtime.screenshot(),
          ]),
          this.captureTimeoutMs,
          () => new PreviewError(
            "screenshot-failed",
            "WeChat DevTools did not respond to a simulator capture in time.",
            { action: "Check that the Mini Program simulator is open, then run Reconnect." },
          ),
        );
      } catch (error) {
        throw classifyRuntimeError(error);
      }
      if (typeof screenshot !== "string" || screenshot.trim().length === 0) {
        throw new PreviewError(
          "screenshot-failed",
          "WeChat DevTools returned an empty simulator screenshot.",
          { action: "Check that the Mini Program simulator is open, then reconnect." },
        );
      }

      latestData = normalizeScreenshotData(screenshot);
      if (latestData.length === 0) {
        throw new PreviewError(
          "screenshot-failed",
          "WeChat DevTools returned an empty simulator screenshot.",
          { action: "Check that the Mini Program simulator is open, then reconnect." },
        );
      }
      latestPagePath = page?.path;
      latestStack = stack.map((item) => item.path);
      const hash = createHash("sha1").update(latestData).digest("hex");
      if (previousHash === hash || attempt === this.maxAttempts - 1) {
        const capturedAt = Date.now();
        return {
          data: latestData,
          screenshotSize: pngDimensions(latestData),
          pagePath: latestPagePath,
          pageStack: latestStack,
          capturedAt,
          captureLatencyMs: capturedAt - startedAt,
          attempts,
        };
      }
      previousHash = hash;
    }

    // The loop always returns or throws; this is a defensive guard for future edits.
    throw new PreviewError("screenshot-failed", "Unable to capture a stable simulator screenshot.");
  }
}

type BoundedOperation = <T>(operation: () => Promise<T> | T, action: string) => Promise<T>;

function adaptInteractionPage(page: AutomatorPage, callOperation: BoundedOperation): RuntimePage {
  return {
    path: page.path,
    $: async (selector) => {
      if (!page.$) {
        throw interactionUnsupported("Element lookup is unavailable in this Automator runtime.");
      }
      const element = await callOperation(() => page.$!(selector), `resolve selector ${selector}`);
      return element ? adaptInteractionElement(element, callOperation) : null;
    },
    $$: async (selector) => {
      if (!page.$$) {
        throw interactionUnsupported("Element discovery is unavailable in this Automator runtime.");
      }
      const elements = await callOperation(() => page.$$!(selector), `resolve selector ${selector}`);
      const resolved = await Promise.all(elements.map(async (element) => {
        try {
          return await adaptInteractionElement(element, callOperation);
        } catch {
          // One element with unreadable geometry must not make every other
          // visible target inaccessible. A total selector failure still times
          // out at the controller boundary and is marked unavailable there.
          return undefined;
        }
      }));
      return resolved.filter((element): element is ResolvedElement => element !== undefined);
    },
    scrollTop: page.scrollTop ? () => callOperation(() => page.scrollTop!(), "read page scroll position") : undefined,
  };
}

async function adaptInteractionElement(element: AutomatorElement, callOperation: BoundedOperation): Promise<ResolvedElement> {
  if (!element.offset || !element.size) {
    throw interactionUnsupported(`Geometry is unavailable for ${element.tagName || "this element"}.`);
  }

  const [offset, size] = await Promise.all([
    callOperation(() => element.offset!(), `read ${element.tagName || "element"} offset`),
    callOperation(() => element.size!(), `read ${element.tagName || "element"} size`),
  ]);
  const rect: RuntimeRect = {
    left: finiteNumber(offset.left),
    top: finiteNumber(offset.top),
    width: finiteNumber(offset.width) ?? finiteNumber(size.width),
    height: finiteNumber(offset.height) ?? finiteNumber(size.height),
  } as RuntimeRect;

  if (!isValidRect(rect)) {
    throw interactionUnsupported(`WeChat DevTools did not provide usable geometry for ${element.tagName || "this element"}.`);
  }

  return {
    tagName: element.tagName,
    rect,
    tap: () => callOperation(() => element.tap(), `tap ${element.tagName || "element"}`),
    input: element.input ? (value) => callOperation(() => element.input!(value), `input text into ${element.tagName || "element"}`) : undefined,
    scrollTo: element.scrollTo ? (x, y) => callOperation(() => element.scrollTo!(x, y), `scroll ${element.tagName || "element"}`) : undefined,
    property: element.property ? (name) => callOperation(() => element.property!(name), `read ${element.tagName || "element"} property ${name}`) : undefined,
  };
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const normalized = value.trim();
    // Automator can return computed geometry as CSS pixels (for example
    // "123.5px") rather than a number. Accept only the explicit formats its
    // element APIs expose; parseFloat would quietly turn unrelated CSS such as
    // "12px solid" into a coordinate.
    const match = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))(?:px)?$/i.exec(normalized);
    if (match) {
      const parsed = Number(match[1]);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
  }
  return undefined;
}

function isValidRect(rect: Partial<RuntimeRect>): rect is RuntimeRect {
  return Number.isFinite(rect.left)
    && Number.isFinite(rect.top)
    && Number.isFinite(rect.width)
    && Number.isFinite(rect.height)
    && (rect.width ?? 0) > 0
    && (rect.height ?? 0) > 0;
}

function interactionUnsupported(message: string): PreviewError {
  return new PreviewError("interaction-unsupported", message);
}

function normalizeScreenshotData(screenshot: string): string {
  const trimmed = screenshot.trim();
  const match = /^data:[^,]+,([\s\S]*)$/i.exec(trimmed);
  const payload = match?.[1] ?? trimmed;
  // Automator normally returns raw base64, but releases and wrappers may add a
  // data-URI prefix or line wrapping. Whitespace is not meaningful in base64.
  return payload.replace(/\s+/g, "");
}

function classifyRuntimeError(error: unknown): PreviewError {
  if (error instanceof PreviewError) {
    return error;
  }

  const message = errorMessage(error);
  if (/connection closed|check if wechat|websocket|socket.*(?:closed|not connected)|econn(?:reset|refused)|epipe/i.test(message)) {
    return new PreviewError(
      "runtime-disconnected",
      "The WeChat DevTools connection closed while capturing the preview.",
      { cause: error, action: "Run Mini Program: Reconnect." },
    );
  }

  return PreviewError.from(error, "screenshot-failed");
}

function classifyOperationError(error: unknown, action: string): PreviewError {
  if (error instanceof PreviewError) {
    return error;
  }

  const message = errorMessage(error);
  if (/connection closed|check if wechat|websocket|socket.*(?:closed|not connected)|econn(?:reset|refused)|epipe/i.test(message)) {
    return new PreviewError(
      "runtime-disconnected",
      `The WeChat DevTools connection closed while trying to ${action}.`,
      { cause: error, action: "Run Mini Program: Reconnect." },
    );
  }

  return PreviewError.from(error, "interaction-unsupported");
}

/**
 * Only the IHDR header is needed. Keeping this parser deliberately small avoids
 * accepting dimensions from arbitrary text while allowing the Webview to bind
 * an interaction to the exact screenshot generation it displays.
 */
function pngDimensions(base64: string): { readonly width: number; readonly height: number } | undefined {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    return undefined;
  }

  if (
    bytes.length < 24
    || bytes[0] !== 0x89
    || bytes[1] !== 0x50
    || bytes[2] !== 0x4e
    || bytes[3] !== 0x47
    || bytes[4] !== 0x0d
    || bytes[5] !== 0x0a
    || bytes[6] !== 0x1a
    || bytes[7] !== 0x0a
    || bytes.toString("ascii", 12, 16) !== "IHDR"
  ) {
    return undefined;
  }

  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, timeoutError: () => PreviewError): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(timeoutError());
    }, timeoutMs);

    void operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function normalizeInteger(value: number | undefined, fallback: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new PreviewError("screenshot-failed", "Preview refresh was superseded by a newer filesystem change.");
  }
}

async function waitWithAbort(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) {
    throwIfAborted(signal);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer) {
        clearTimeout(timer);
      }
      reject(new PreviewError("screenshot-failed", "Preview refresh was superseded by a newer filesystem change."));
    };

    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
  });
}
