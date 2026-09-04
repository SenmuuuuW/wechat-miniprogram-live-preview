/**
 * Messages accepted from the untrusted preview Webview.
 *
 * Keep this boundary deliberately narrow: Webview payloads are data, not commands,
 * until they have passed this parser.
 */
export interface ReadyPreviewMessage {
  readonly type: "ready";
}

export interface ReconnectPreviewMessage {
  readonly type: "reconnect";
}

export interface RefreshPreviewMessage {
  readonly type: "refresh";
}

export interface BackPreviewMessage {
  readonly type: "back";
}

export interface ExitTypingPreviewMessage {
  readonly type: "exitTyping";
}

export interface PreviewRenderedMessage {
  readonly type: "previewRendered";
  readonly generation: number;
}

export interface TapPreviewMessage {
  readonly type: "tap";
  readonly generation: number;
  readonly screenshotX: number;
  readonly screenshotY: number;
}

export interface ScrollPreviewMessage {
  readonly type: "scroll";
  readonly generation: number;
  readonly screenshotX: number;
  readonly screenshotY: number;
  readonly deltaX: number;
  readonly deltaY: number;
}

export interface InputPreviewMessage {
  readonly type: "input";
  readonly generation: number;
  readonly value: string;
}

export type PreviewInteractionMessage =
  | BackPreviewMessage
  | ExitTypingPreviewMessage
  | TapPreviewMessage
  | ScrollPreviewMessage
  | InputPreviewMessage;

export type PreviewWebviewMessage =
  | ReadyPreviewMessage
  | ReconnectPreviewMessage
  | RefreshPreviewMessage
  | PreviewRenderedMessage
  | PreviewInteractionMessage;

/** Maximum text length accepted in one Webview input batch. */
export const MAX_INPUT_LENGTH = 10_000;

/** Maximum magnitude accepted for one normalized wheel/drag scroll message. */
export const MAX_SCROLL_DELTA = 10_000;

/**
 * Parses one Webview-to-extension message. Invalid or unexpected payloads are
 * intentionally ignored instead of throwing into VS Code's message callback.
 */
export function parsePreviewWebviewMessage(value: unknown): PreviewWebviewMessage | undefined {
  try {
    if (!isRecord(value) || typeof value.type !== "string") {
      return undefined;
    }

    switch (value.type) {
      case "ready":
        return hasExactKeys(value, ["type"]) ? { type: "ready" } : undefined;
      case "reconnect":
        return hasExactKeys(value, ["type"]) ? { type: "reconnect" } : undefined;
      case "refresh":
        return hasExactKeys(value, ["type"]) ? { type: "refresh" } : undefined;
      case "back":
        return hasExactKeys(value, ["type"]) ? { type: "back" } : undefined;
      case "exitTyping":
        return hasExactKeys(value, ["type"]) ? { type: "exitTyping" } : undefined;
      case "previewRendered":
        return parsePreviewRendered(value);
      case "tap":
        return parseTap(value);
      case "scroll":
        return parseScroll(value);
      case "input":
        return parseInput(value);
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function parsePreviewRendered(value: Record<string, unknown>): PreviewRenderedMessage | undefined {
  if (!hasExactKeys(value, ["type", "generation"]) || !isGeneration(value.generation)) {
    return undefined;
  }
  return { type: "previewRendered", generation: value.generation };
}

function parseTap(value: Record<string, unknown>): TapPreviewMessage | undefined {
  if (
    !hasExactKeys(value, ["type", "generation", "screenshotX", "screenshotY"])
    || !isGeneration(value.generation)
    || !isScreenshotCoordinate(value.screenshotX)
    || !isScreenshotCoordinate(value.screenshotY)
  ) {
    return undefined;
  }
  return {
    type: "tap",
    generation: value.generation,
    screenshotX: value.screenshotX,
    screenshotY: value.screenshotY,
  };
}

function parseScroll(value: Record<string, unknown>): ScrollPreviewMessage | undefined {
  if (
    !hasExactKeys(value, ["type", "generation", "screenshotX", "screenshotY", "deltaX", "deltaY"])
    || !isGeneration(value.generation)
    || !isScreenshotCoordinate(value.screenshotX)
    || !isScreenshotCoordinate(value.screenshotY)
    || !isScrollDelta(value.deltaX)
    || !isScrollDelta(value.deltaY)
  ) {
    return undefined;
  }
  return {
    type: "scroll",
    generation: value.generation,
    screenshotX: value.screenshotX,
    screenshotY: value.screenshotY,
    deltaX: value.deltaX,
    deltaY: value.deltaY,
  };
}

function parseInput(value: Record<string, unknown>): InputPreviewMessage | undefined {
  if (
    !hasExactKeys(value, ["type", "generation", "value"])
    || !isGeneration(value.generation)
    || typeof value.value !== "string"
    || value.value.length > MAX_INPUT_LENGTH
  ) {
    return undefined;
  }
  return { type: "input", generation: value.generation, value: value.value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && keys.every((key) => typeof key === "string" && expected.includes(key));
}

function isGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isScreenshotCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isScrollDelta(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_SCROLL_DELTA;
}
