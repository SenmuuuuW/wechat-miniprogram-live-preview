import type {
  DragGesture,
  GestureMetrics,
  HoldGesture,
  Point,
  PointerGesture,
  PointerSample,
  SwipeDirection,
  SwipeGesture,
  TapGesture,
  WheelGesture,
  WheelSample,
} from "./InteractionTypes";

export const DEFAULT_TAP_MAX_DISTANCE_PX = 8;
export const DEFAULT_TAP_MAX_DURATION_MS = 450;
export const DEFAULT_SWIPE_MIN_DISTANCE_PX = 24;
export const DEFAULT_SWIPE_MAX_DURATION_MS = 1_500;
export const DEFAULT_WHEEL_IDLE_MS = 80;
export const DEFAULT_WHEEL_MIN_MAGNITUDE_PX = 1;

export interface GestureControllerOptions {
  /** Maximum start-to-path distance for a pointer gesture to remain a tap. */
  readonly tapMaxDistancePx?: number;
  /** A stationary pointer exceeding this duration is reported as a hold. */
  readonly tapMaxDurationMs?: number;
  /** Minimum final displacement required for a directional swipe. */
  readonly swipeMinDistancePx?: number;
  /** Slow drags are deliberately not converted into a swipe. */
  readonly swipeMaxDurationMs?: number;
}

export interface WheelGestureAggregatorOptions {
  /** A quiet period this long closes a coalesced wheel gesture. */
  readonly idleMs?: number;
  /** Batches below this Euclidean magnitude are discarded as noise. */
  readonly minimumMagnitudePx?: number;
}

interface NormalizedGestureOptions {
  readonly tapMaxDistancePx: number;
  readonly tapMaxDurationMs: number;
  readonly swipeMinDistancePx: number;
  readonly swipeMaxDurationMs: number;
}

interface ActivePointer {
  readonly pointerId: number | undefined;
  readonly start: PointerSample;
  last: PointerSample;
  maxDistance: number;
  pathLength: number;
}

interface PendingWheelGesture {
  readonly startedAt: number;
  lastAt: number;
  deltaX: number;
  deltaY: number;
  eventCount: number;
  anchor: Point;
}

/**
 * Classifies supplied pointer samples. It deliberately returns drag/hold
 * rather than turning ambiguous input into a runtime tap.
 */
export class GestureController {
  private readonly options: NormalizedGestureOptions;
  private active: ActivePointer | undefined;

  public constructor(options: GestureControllerOptions = {}) {
    this.options = normalizeGestureOptions(options);
  }

  public get isTracking(): boolean {
    return this.active !== undefined;
  }

  /** Starts (or replaces) the current pointer sequence. Invalid samples are ignored. */
  public begin(sample: PointerSample): void {
    if (!isValidPointerSample(sample)) {
      return;
    }

    const start = copyPointerSample(sample);
    this.active = {
      pointerId: start.pointerId,
      start,
      last: start,
      maxDistance: 0,
      pathLength: 0,
    };
  }

  /** Adds a movement sample for the active pointer. */
  public move(sample: PointerSample): void {
    const active = this.active;
    if (!active || !isValidPointerSample(sample) || !matchesPointer(active.pointerId, sample.pointerId)) {
      return;
    }

    const next = normalizePointerTime(sample, active.last.timestamp);
    active.pathLength += distance(active.last, next);
    active.maxDistance = Math.max(active.maxDistance, distance(active.start, next));
    active.last = next;
  }

  /** Finishes the matching pointer sequence and returns its conservative classification. */
  public end(sample: PointerSample): PointerGesture | undefined {
    const active = this.active;
    if (!active || !isValidPointerSample(sample) || !matchesPointer(active.pointerId, sample.pointerId)) {
      return undefined;
    }

    const end = normalizePointerTime(sample, active.last.timestamp);
    active.pathLength += distance(active.last, end);
    active.maxDistance = Math.max(active.maxDistance, distance(active.start, end));
    this.active = undefined;

    return classifyGesture(active.start, end, active.maxDistance, active.pathLength, this.options);
  }

  /** Clears the sequence, optionally only when it belongs to a particular pointer. */
  public cancel(pointerId?: number): void {
    if (!this.active || (pointerId !== undefined && !matchesPointer(this.active.pointerId, pointerId))) {
      return;
    }
    this.active = undefined;
  }
}

/**
 * Coalesces browser-normalized wheel samples without owning a DOM timer. The
 * caller schedules `flushIfDue` using `dueAt`, so every wheel delta need not
 * become a runtime RPC.
 */
export class WheelGestureAggregator {
  private readonly idleMs: number;
  private readonly minimumMagnitudePx: number;
  private pending: PendingWheelGesture | undefined;

  public constructor(options: WheelGestureAggregatorOptions = {}) {
    this.idleMs = normalizeNonNegative(options.idleMs, DEFAULT_WHEEL_IDLE_MS);
    this.minimumMagnitudePx = normalizeNonNegative(
      options.minimumMagnitudePx,
      DEFAULT_WHEEL_MIN_MAGNITUDE_PX,
    );
  }

  public get hasPending(): boolean {
    return this.pending !== undefined;
  }

  /** The timestamp at which `flushIfDue` can emit the current batch. */
  public get dueAt(): number | undefined {
    return this.pending ? this.pending.lastAt + this.idleMs : undefined;
  }

  /**
   * Adds a sample. A new sample following an idle gap returns the finished
   * prior batch and begins a new one in the same call.
   */
  public push(sample: WheelSample): WheelGesture | undefined {
    if (!isValidWheelSample(sample)) {
      return undefined;
    }

    const completed = this.pending && sample.timestamp >= this.pending.lastAt + this.idleMs
      ? this.takePending()
      : undefined;

    if (sample.deltaX === 0 && sample.deltaY === 0) {
      return completed;
    }

    if (!this.pending) {
      this.pending = {
        startedAt: sample.timestamp,
        lastAt: sample.timestamp,
        deltaX: sample.deltaX,
        deltaY: sample.deltaY,
        eventCount: 1,
        anchor: { ...sample.position },
      };
      return completed;
    }

    this.pending.deltaX += sample.deltaX;
    this.pending.deltaY += sample.deltaY;
    this.pending.eventCount += 1;
    this.pending.lastAt = Math.max(this.pending.lastAt, sample.timestamp);
    this.pending.anchor = { ...sample.position };
    return completed;
  }

  /** Emits a pending batch only after it has been quiet for `idleMs`. */
  public flushIfDue(now: number): WheelGesture | undefined {
    if (!this.pending || !Number.isFinite(now) || now < this.pending.lastAt + this.idleMs) {
      return undefined;
    }
    return this.takePending();
  }

  /** Emits the pending batch immediately, for example when the preview loses focus. */
  public flush(): WheelGesture | undefined {
    return this.takePending();
  }

  public clear(): void {
    this.pending = undefined;
  }

  private takePending(): WheelGesture | undefined {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending || Math.hypot(pending.deltaX, pending.deltaY) < this.minimumMagnitudePx) {
      return undefined;
    }

    const dominantAxis = Math.abs(pending.deltaX) >= Math.abs(pending.deltaY)
      ? "horizontal"
      : "vertical";
    return {
      kind: "wheel",
      anchor: pending.anchor,
      delta: { x: pending.deltaX, y: pending.deltaY },
      dominantAxis,
      eventCount: pending.eventCount,
      startedAt: pending.startedAt,
      endedAt: pending.lastAt,
      durationMs: pending.lastAt - pending.startedAt,
    };
  }
}

function classifyGesture(
  start: PointerSample,
  end: PointerSample,
  maxDistance: number,
  pathLength: number,
  options: NormalizedGestureOptions,
): PointerGesture {
  const delta = { x: end.x - start.x, y: end.y - start.y };
  const metrics: GestureMetrics = {
    start: { x: start.x, y: start.y },
    end: { x: end.x, y: end.y },
    delta,
    distance: Math.hypot(delta.x, delta.y),
    maxDistance,
    pathLength,
    durationMs: Math.max(0, end.timestamp - start.timestamp),
  };

  if (metrics.maxDistance <= options.tapMaxDistancePx) {
    return metrics.durationMs <= options.tapMaxDurationMs
      ? { kind: "tap", ...metrics } satisfies TapGesture
      : { kind: "hold", ...metrics } satisfies HoldGesture;
  }

  if (metrics.distance >= options.swipeMinDistancePx && metrics.durationMs <= options.swipeMaxDurationMs) {
    return {
      kind: "swipe",
      direction: swipeDirection(delta),
      ...metrics,
    } satisfies SwipeGesture;
  }

  return { kind: "drag", ...metrics } satisfies DragGesture;
}

function swipeDirection(delta: Point): SwipeDirection {
  if (Math.abs(delta.x) >= Math.abs(delta.y)) {
    return delta.x >= 0 ? "right" : "left";
  }
  return delta.y >= 0 ? "down" : "up";
}

function normalizeGestureOptions(options: GestureControllerOptions): NormalizedGestureOptions {
  const tapMaxDistancePx = normalizeNonNegative(options.tapMaxDistancePx, DEFAULT_TAP_MAX_DISTANCE_PX);
  return {
    tapMaxDistancePx,
    tapMaxDurationMs: normalizeNonNegative(options.tapMaxDurationMs, DEFAULT_TAP_MAX_DURATION_MS),
    swipeMinDistancePx: Math.max(
      tapMaxDistancePx,
      normalizeNonNegative(options.swipeMinDistancePx, DEFAULT_SWIPE_MIN_DISTANCE_PX),
    ),
    swipeMaxDurationMs: normalizeNonNegative(options.swipeMaxDurationMs, DEFAULT_SWIPE_MAX_DURATION_MS),
  };
}

function normalizeNonNegative(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value < 0 ? fallback : value;
}

function isValidPointerSample(sample: PointerSample): boolean {
  return Number.isFinite(sample.x)
    && Number.isFinite(sample.y)
    && Number.isFinite(sample.timestamp)
    && (sample.pointerId === undefined || Number.isFinite(sample.pointerId));
}

function copyPointerSample(sample: PointerSample): PointerSample {
  return sample.pointerId === undefined
    ? { x: sample.x, y: sample.y, timestamp: sample.timestamp }
    : { x: sample.x, y: sample.y, timestamp: sample.timestamp, pointerId: sample.pointerId };
}

function normalizePointerTime(sample: PointerSample, minimumTimestamp: number): PointerSample {
  const normalized = copyPointerSample(sample);
  return normalized.timestamp >= minimumTimestamp
    ? normalized
    : { ...normalized, timestamp: minimumTimestamp };
}

function matchesPointer(activePointerId: number | undefined, samplePointerId: number | undefined): boolean {
  return activePointerId === undefined || samplePointerId === undefined || activePointerId === samplePointerId;
}

function distance(left: Point, right: Point): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function isValidWheelSample(sample: WheelSample): boolean {
  return Number.isFinite(sample.position.x)
    && Number.isFinite(sample.position.y)
    && Number.isFinite(sample.deltaX)
    && Number.isFinite(sample.deltaY)
    && Number.isFinite(sample.timestamp);
}
