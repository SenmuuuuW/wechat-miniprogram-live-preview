import type { RefreshClock } from "../refresh/RefreshScheduler";

export type RuntimeOperationKind =
  | "code-refresh"
  | "manual-refresh"
  | "tap"
  | "scroll"
  | "input"
  | "back"
  | "health-check";

export type RuntimeOperationState = "idle" | "debouncing" | "refreshing" | "interacting" | "disposed";

export interface RuntimeOperationContext {
  /** Monotonic operation id, useful for correlating preview timing. */
  readonly generation: number;
  readonly kind: RuntimeOperationKind;
  readonly requestedAt: number;
  readonly reasons: readonly string[];
  readonly signal: AbortSignal;
  /** False after session invalidation, disposal, or a newer source refresh. */
  isCurrent(): boolean;
  isStale(): boolean;
}

export interface RuntimeOperationSnapshot {
  readonly state: RuntimeOperationState;
  readonly generation: number;
  readonly runningGeneration: number | undefined;
  readonly hasPendingRefresh: boolean;
  readonly pendingInteractions: number;
  readonly debounceMs: number;
}

export interface RuntimeOperationSchedulerOptions<TResult> {
  readonly debounceMs?: number;
  /** Bounds a third-party Automator action or capture that ignores AbortSignal. */
  readonly operationTimeoutMs?: number;
  /** Capture and return the current runtime frame after an operation settles. */
  readonly capture: (context: RuntimeOperationContext) => Promise<TResult> | TResult;
  /** Executes an interaction before its post-operation capture. */
  readonly performInteraction?: (context: RuntimeOperationContext, action: () => Promise<void> | void) => Promise<void> | void;
  readonly commit?: (result: TResult, context: RuntimeOperationContext) => Promise<void> | void;
  readonly onError?: (error: unknown, context: RuntimeOperationContext) => Promise<void> | void;
  readonly onStateChange?: (snapshot: RuntimeOperationSnapshot) => void;
  readonly clock?: RefreshClock;
}

interface PendingRefresh {
  generation: number;
  requestedAt: number;
  dueAt: number;
  kind: "code-refresh" | "manual-refresh";
  readonly reasons: Set<string>;
}

interface QueuedInteraction {
  readonly generation: number;
  readonly requestedAt: number;
  readonly kind: Exclude<RuntimeOperationKind, "code-refresh" | "manual-refresh">;
  readonly reason: string;
  readonly action: () => Promise<void> | void;
}

interface ActiveOperation {
  readonly context: RuntimeOperationContext;
  readonly controller: AbortController;
  readonly sourceGeneration: number | undefined;
}

const systemClock: RefreshClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Serializes every operation that touches an Automator runtime. Source refreshes
 * are debounced and coalesced, while started interactions are never aborted by
 * later filesystem writes. Session invalidation gates every late publication.
 */
export class RuntimeOperationScheduler<TResult = void> {
  private readonly debounceMs: number;
  private readonly operationTimeoutMs: number;
  private readonly capture: (context: RuntimeOperationContext) => Promise<TResult> | TResult;
  private readonly performInteraction: (
    context: RuntimeOperationContext,
    action: () => Promise<void> | void,
  ) => Promise<void> | void;
  private readonly commit: ((result: TResult, context: RuntimeOperationContext) => Promise<void> | void) | undefined;
  private readonly onError: ((error: unknown, context: RuntimeOperationContext) => Promise<void> | void) | undefined;
  private readonly onStateChange: ((snapshot: RuntimeOperationSnapshot) => void) | undefined;
  private readonly clock: RefreshClock;

  private debounceTimer: unknown | undefined;
  private pendingRefresh: PendingRefresh | undefined;
  private readonly interactions: QueuedInteraction[] = [];
  private running: ActiveOperation | undefined;
  private desiredGeneration = 0;
  private desiredRefreshGeneration = 0;
  private lifecycleGeneration = 0;
  private disposed = false;
  private currentState: RuntimeOperationState = "idle";

  public constructor(options: RuntimeOperationSchedulerOptions<TResult>) {
    this.debounceMs = normalizeDebounceMs(options.debounceMs);
    this.operationTimeoutMs = normalizeOperationTimeoutMs(options.operationTimeoutMs);
    this.capture = options.capture;
    this.performInteraction = options.performInteraction ?? (async (_context, action) => action());
    this.commit = options.commit;
    this.onError = options.onError;
    this.onStateChange = options.onStateChange;
    this.clock = options.clock ?? systemClock;
  }

  public get state(): RuntimeOperationState {
    return this.currentState;
  }

  public get generation(): number {
    return this.desiredGeneration;
  }

  public snapshot(): RuntimeOperationSnapshot {
    return {
      state: this.currentState,
      generation: this.desiredGeneration,
      runningGeneration: this.running?.context.generation,
      hasPendingRefresh: this.pendingRefresh !== undefined,
      pendingInteractions: this.interactions.length,
      debounceMs: this.debounceMs,
    };
  }

  /** Queue a coalesced filesystem refresh after the configured debounce. */
  public requestRefresh(reason = "filesystem"): number {
    return this.enqueueRefresh("code-refresh", reason, false);
  }

  /** Queue an explicit user refresh. It never interrupts an active interaction. */
  public requestImmediateRefresh(reason = "manual"): number {
    return this.enqueueRefresh("manual-refresh", reason, true);
  }

  /** Queue a real runtime side effect followed by one stable-frame capture. */
  public enqueueInteraction(
    kind: Exclude<RuntimeOperationKind, "code-refresh" | "manual-refresh">,
    action: () => Promise<void> | void,
    reason = kind,
  ): number {
    if (this.disposed) {
      return this.desiredGeneration;
    }

    const generation = ++this.desiredGeneration;
    this.interactions.push({ generation, requestedAt: this.clock.now(), kind, reason: reason || kind, action });

    // A screenshot-only refresh has no user-visible side effect and can yield to
    // an interaction. Abort is cooperative; the serial drain resumes afterwards.
    if (this.running?.context.kind === "code-refresh" || this.running?.context.kind === "manual-refresh") {
      this.running.controller.abort();
    }
    this.clearDebounceTimer();
    this.drain();
    return generation;
  }

  /** Make all pending/running completions stale without disposing the instance. */
  public invalidate(): void {
    if (this.disposed) {
      return;
    }
    this.lifecycleGeneration += 1;
    this.pendingRefresh = undefined;
    this.interactions.splice(0);
    this.clearDebounceTimer();
    this.running?.controller.abort();
    if (!this.running) {
      this.setState("idle");
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.lifecycleGeneration += 1;
    this.pendingRefresh = undefined;
    this.interactions.splice(0);
    this.clearDebounceTimer();
    this.running?.controller.abort();
    this.setState("disposed");
  }

  private enqueueRefresh(kind: "code-refresh" | "manual-refresh", reason: string, immediate: boolean): number {
    if (this.disposed) {
      return this.desiredGeneration;
    }

    const now = this.clock.now();
    const generation = ++this.desiredGeneration;
    this.desiredRefreshGeneration = generation;
    const dueAt = immediate ? now : now + this.debounceMs;
    const normalizedReason = reason || (immediate ? "manual" : "filesystem");

    if (this.pendingRefresh) {
      this.pendingRefresh.generation = generation;
      this.pendingRefresh.requestedAt = now;
      this.pendingRefresh.dueAt = dueAt;
      this.pendingRefresh.kind = immediate ? "manual-refresh" : this.pendingRefresh.kind;
      this.pendingRefresh.reasons.add(normalizedReason);
    } else {
      this.pendingRefresh = {
        generation,
        requestedAt: now,
        dueAt,
        kind,
        reasons: new Set([normalizedReason]),
      };
    }

    // Filesystem updates may supersede an in-flight screenshot, but never an
    // interaction that has already begun changing the real runtime.
    if (this.running && isRefreshKind(this.running.context.kind)) {
      this.running.controller.abort();
      return generation;
    }

    this.drain();
    return generation;
  }

  private drain(): void {
    if (this.disposed || this.running) {
      return;
    }

    const interaction = this.interactions.shift();
    if (interaction) {
      this.startInteraction(interaction);
      return;
    }

    if (!this.pendingRefresh) {
      this.setState("idle");
      return;
    }

    const delay = this.pendingRefresh.dueAt - this.clock.now();
    if (delay > 0) {
      this.scheduleRefresh(delay);
      return;
    }

    this.startRefresh(this.pendingRefresh);
  }

  private scheduleRefresh(delayMs: number): void {
    if (this.debounceTimer !== undefined || this.disposed) {
      return;
    }
    this.setState("debouncing");
    this.debounceTimer = this.clock.setTimeout(() => {
      this.debounceTimer = undefined;
      this.drain();
    }, Math.max(0, delayMs));
  }

  private startRefresh(refresh: PendingRefresh): void {
    if (this.disposed || this.running || this.pendingRefresh !== refresh) {
      return;
    }
    this.pendingRefresh = undefined;
    const active = this.createActive(refresh.generation, refresh.kind, refresh.requestedAt, [...refresh.reasons], refresh.generation);
    this.running = active;
    this.setState("refreshing");
    void this.execute(active);
  }

  private startInteraction(interaction: QueuedInteraction): void {
    if (this.disposed || this.running) {
      return;
    }
    const active = this.createActive(interaction.generation, interaction.kind, interaction.requestedAt, [interaction.reason]);
    this.running = active;
    this.setState("interacting");
    void this.execute(active, interaction.action);
  }

  private createActive(
    generation: number,
    kind: RuntimeOperationKind,
    requestedAt: number,
    reasons: readonly string[],
    sourceGeneration?: number,
  ): ActiveOperation {
    const controller = new AbortController();
    const lifecycleGeneration = this.lifecycleGeneration;
    const context: RuntimeOperationContext = {
      generation,
      kind,
      requestedAt,
      reasons: Object.freeze([...reasons]),
      signal: controller.signal,
      isCurrent: () => {
        if (this.disposed || controller.signal.aborted || lifecycleGeneration !== this.lifecycleGeneration) {
          return false;
        }
        return sourceGeneration === undefined || sourceGeneration === this.desiredRefreshGeneration;
      },
      isStale: () => !context.isCurrent(),
    };
    return { context, controller, sourceGeneration };
  }

  private async execute(active: ActiveOperation, interaction?: () => Promise<void> | void): Promise<void> {
    try {
      if (interaction) {
        await this.runBounded(
          () => this.performInteraction(active.context, interaction),
          `Runtime ${active.context.kind} operation timed out after ${this.operationTimeoutMs} ms.`,
        );
      }
      const result = await this.runBounded(
        () => this.capture(active.context),
        `Runtime ${active.context.kind} capture timed out after ${this.operationTimeoutMs} ms.`,
      );
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
      if (!this.disposed) {
        this.drain();
      }
    }
  }

  private runBounded<T>(operation: () => Promise<T> | T, message: string): Promise<T> | T {
    // PreviewSession's capture and interaction adapters already bound every
    // Automator call individually. A zero timeout opts that integration out of
    // a redundant outer Promise wrapper while retaining the scheduler's
    // watchdog for standalone consumers that need it.
    if (this.operationTimeoutMs === 0) {
      return operation();
    }
    return withTimeout(operation, this.operationTimeoutMs, message);
  }

  private canPublish(active: ActiveOperation): boolean {
    return this.running === active && active.context.isCurrent();
  }

  private async reportError(error: unknown, context: RuntimeOperationContext): Promise<void> {
    try {
      await this.onError?.(error, context);
    } catch {
      // Reporting an error must not strand subsequent runtime work.
    }
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer === undefined) {
      return;
    }
    this.clock.clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
  }

  private setState(state: RuntimeOperationState): void {
    if (state === this.currentState) {
      return;
    }
    this.currentState = state;
    this.onStateChange?.(this.snapshot());
  }
}

function isRefreshKind(kind: RuntimeOperationKind): kind is "code-refresh" | "manual-refresh" {
  return kind === "code-refresh" || kind === "manual-refresh";
}

function normalizeDebounceMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 350;
  }
  return Math.max(0, Math.floor(value));
}

function normalizeOperationTimeoutMs(value: number | undefined): number {
  if (value === 0) {
    return 0;
  }
  if (value === undefined || !Number.isFinite(value)) {
    return 30_000;
  }
  return Math.min(120_000, Math.max(100, Math.floor(value)));
}

function withTimeout<T>(operation: () => Promise<T> | T, timeoutMs: number, message: string): Promise<T> | T {
  // Keep the synchronous path synchronous. This is important for the queue's
  // established ordering: a fake or adapter operation that returns a value
  // should not acquire an extra pair of microtasks merely because timeout
  // protection is enabled.
  let result: Promise<T> | T;
  try {
    result = operation();
  } catch (error) {
    return Promise.reject(error);
  }

  if (!isPromiseLike(result)) {
    return result;
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error(message));
    }, timeoutMs);

    // Attach handlers immediately so a late third-party rejection after our
    // timeout cannot become an unhandled rejection. The scheduler's generation
    // gate ignores any late value from this abandoned operation.
    void result.then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === "object"
    && value !== null
    && typeof (value as { then?: unknown }).then === "function";
}
