export const DEFAULT_REFRESH_DEBOUNCE_MS = 350;

export type RefreshSchedulerState = "idle" | "debouncing" | "refreshing" | "disposed";
export type RefreshReason = string;

export interface RefreshClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RefreshContext {
  /** Increments for every request, including coalesced and stale requests. */
  readonly generation: number;
  /** Timestamp of the most recent request represented by this refresh. */
  readonly requestedAt: number;
  /** All reasons that were coalesced into this refresh. */
  readonly reasons: readonly RefreshReason[];
  readonly signal: AbortSignal;
  /** True only while this is still the newest requested generation. */
  isCurrent(): boolean;
  isStale(): boolean;
}

export interface RefreshSchedulerSnapshot {
  readonly state: RefreshSchedulerState;
  readonly generation: number;
  readonly runningGeneration: number | undefined;
  readonly hasPendingRefresh: boolean;
  readonly debounceMs: number;
}

export interface RefreshSchedulerOptions<TResult> {
  readonly debounceMs?: number;
  /** Executes the serialized runtime-update and screenshot pipeline. */
  readonly perform: (context: RefreshContext) => Promise<TResult> | TResult;
  /**
   * Receives a result only while its context remains current. Keep UI publication
   * here so a late screenshot cannot overwrite the newest preview.
   */
  readonly commit?: (result: TResult, context: RefreshContext) => Promise<void> | void;
  /** Receives failures only for the current generation. */
  readonly onError?: (error: unknown, context: RefreshContext) => Promise<void> | void;
  readonly onStateChange?: (snapshot: RefreshSchedulerSnapshot) => void;
  readonly clock?: RefreshClock;
}

interface PendingRefresh {
  generation: number;
  requestedAt: number;
  dueAt: number;
  readonly reasons: Set<RefreshReason>;
}

interface ActiveRefresh {
  readonly controller: AbortController;
  readonly context: RefreshContext;
}

const systemClock: RefreshClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Coalesces workspace writes into one serialized refresh pipeline. It never runs
 * two runtime requests at once and gates result/error publication by generation.
 */
export class RefreshScheduler<TResult = void> {
  private readonly debounceMs: number;
  private readonly perform: (context: RefreshContext) => Promise<TResult> | TResult;
  private readonly commit: ((result: TResult, context: RefreshContext) => Promise<void> | void) | undefined;
  private readonly onError: ((error: unknown, context: RefreshContext) => Promise<void> | void) | undefined;
  private readonly onStateChange: ((snapshot: RefreshSchedulerSnapshot) => void) | undefined;
  private readonly clock: RefreshClock;

  private debounceTimer: unknown | undefined;
  private pending: PendingRefresh | undefined;
  private running: ActiveRefresh | undefined;
  private desiredGeneration = 0;
  private disposed = false;
  private currentState: RefreshSchedulerState = "idle";

  public constructor(options: RefreshSchedulerOptions<TResult>) {
    this.debounceMs = normalizeDebounceMs(options.debounceMs);
    this.perform = options.perform;
    this.commit = options.commit;
    this.onError = options.onError;
    this.onStateChange = options.onStateChange;
    this.clock = options.clock ?? systemClock;
  }

  public get state(): RefreshSchedulerState {
    return this.currentState;
  }

  public get generation(): number {
    return this.desiredGeneration;
  }

  public snapshot(): RefreshSchedulerSnapshot {
    return {
      state: this.currentState,
      generation: this.desiredGeneration,
      runningGeneration: this.running?.context.generation,
      hasPendingRefresh: this.pending !== undefined,
      debounceMs: this.debounceMs,
    };
  }

  /** Queues a filesystem-triggered refresh after the configured debounce. */
  public request(reason: RefreshReason = "filesystem"): number {
    return this.enqueue(reason, false);
  }

  /** Queues a user-triggered refresh without an initial debounce when possible. */
  public requestImmediate(reason: RefreshReason = "manual"): number {
    return this.enqueue(reason, true);
  }

  /** Stops timers and makes any late worker completion stale. */
  public dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.pending = undefined;
    this.clearDebounceTimer();
    this.running?.controller.abort();
    this.setState("disposed");
  }

  private enqueue(reason: RefreshReason, immediate: boolean): number {
    if (this.disposed) {
      return this.desiredGeneration;
    }

    const now = this.clock.now();
    const generation = ++this.desiredGeneration;
    const normalizedReason = reason || (immediate ? "manual" : "filesystem");
    const dueAt = immediate ? now : now + this.debounceMs;

    if (this.pending) {
      this.pending.generation = generation;
      this.pending.requestedAt = now;
      this.pending.dueAt = dueAt;
      this.pending.reasons.add(normalizedReason);
    } else {
      this.pending = {
        generation,
        requestedAt: now,
        dueAt,
        reasons: new Set([normalizedReason]),
      };
    }

    if (this.running) {
      // Abort is cooperative; the next Automator request waits for this one to settle.
      this.running.controller.abort();
      return generation;
    }

    if (immediate) {
      this.clearDebounceTimer();
      this.startPendingRefresh();
    } else {
      this.schedulePendingRefresh();
    }

    return generation;
  }

  private schedulePendingRefresh(): void {
    if (this.disposed || this.running || !this.pending) {
      return;
    }

    this.clearDebounceTimer();
    const delayMs = Math.max(0, this.pending.dueAt - this.clock.now());
    this.setState("debouncing");
    this.debounceTimer = this.clock.setTimeout(() => {
      this.debounceTimer = undefined;
      this.startPendingRefresh();
    }, delayMs);
  }

  private startPendingRefresh(): void {
    if (this.disposed || this.running || !this.pending) {
      return;
    }

    if (this.pending.dueAt > this.clock.now()) {
      this.schedulePendingRefresh();
      return;
    }

    this.clearDebounceTimer();
    const pending = this.pending;
    this.pending = undefined;

    const controller = new AbortController();
    const isCurrent = (): boolean =>
      !this.disposed && pending.generation === this.desiredGeneration;
    const context: RefreshContext = {
      generation: pending.generation,
      requestedAt: pending.requestedAt,
      reasons: Object.freeze([...pending.reasons]),
      signal: controller.signal,
      isCurrent,
      isStale: () => !isCurrent(),
    };
    const active: ActiveRefresh = { controller, context };
    this.running = active;
    this.setState("refreshing");
    void this.execute(active);
  }

  private async execute(active: ActiveRefresh): Promise<void> {
    try {
      const result = await this.perform(active.context);
      if (this.canPublish(active)) {
        await this.commit?.(result, active.context);
      }
    } catch (error) {
      if (this.canPublish(active)) {
        await this.reportError(error, active.context);
      }
    } finally {
      if (this.running === active) {
        this.running = undefined;
      }

      if (this.disposed) {
        return;
      }

      if (this.pending) {
        this.schedulePendingRefresh();
      } else {
        this.setState("idle");
      }
    }
  }

  private canPublish(active: ActiveRefresh): boolean {
    return this.running === active && active.context.isCurrent();
  }

  private async reportError(error: unknown, context: RefreshContext): Promise<void> {
    try {
      await this.onError?.(error, context);
    } catch {
      // Error reporting must not strand the scheduler in the refreshing state.
    }
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer === undefined) {
      return;
    }

    this.clock.clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
  }

  private setState(state: RefreshSchedulerState): void {
    if (this.currentState === state) {
      return;
    }

    this.currentState = state;
    try {
      this.onStateChange?.(this.snapshot());
    } catch {
      // UI state observers are advisory and must not affect runtime refreshes.
    }
  }
}

function normalizeDebounceMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_REFRESH_DEBOUNCE_MS;
  }

  return Math.max(0, Math.floor(value));
}
