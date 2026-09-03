import { createHash } from "node:crypto";

import { PreviewError, errorMessage } from "../errors/PreviewError";
import type { RefreshContext } from "../refresh/RefreshScheduler";

export interface AutomatorRuntime {
  currentPage(): Promise<AutomatorPage | undefined>;
  pageStack(): Promise<readonly AutomatorPage[]>;
  screenshot(options?: { path?: string }): Promise<string | void>;
  disconnect(): void;
  close?(): Promise<void>;
  on?(event: "console" | "exception", listener: (payload: unknown) => void): this;
}

export interface AutomatorPage {
  readonly path: string;
  readonly query?: Record<string, unknown>;
}

export interface ScreenshotResult {
  readonly data: string;
  readonly pagePath: string | undefined;
  readonly pageStack: readonly string[];
  readonly capturedAt: number;
  readonly captureLatencyMs: number;
  readonly attempts: number;
}

export interface AutomatorClientOptions {
  readonly captureDelayMs?: number;
  readonly maxAttempts?: number;
  readonly wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

/** Thin adapter around the public miniprogram-automator surface. */
export class AutomatorClient {
  private runtime: AutomatorRuntime | undefined;
  private readonly captureDelayMs: number;
  private readonly maxAttempts: number;
  private readonly wait: (delayMs: number, signal?: AbortSignal) => Promise<void>;

  public constructor(options: AutomatorClientOptions = {}) {
    this.captureDelayMs = normalizeInteger(options.captureDelayMs, 180, 0);
    this.maxAttempts = normalizeInteger(options.maxAttempts, 3, 1, 8);
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
        [page, stack, screenshot] = await Promise.all([
          runtime.currentPage(),
          runtime.pageStack(),
          runtime.screenshot(),
        ]);
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
