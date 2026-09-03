export interface PreviewTiming {
  readonly generation: number;
  readonly detectedAt: number;
  readonly debounceCompletedAt?: number;
  readonly capturedAt?: number;
  readonly renderedAt?: number;
  readonly captureLatencyMs?: number;
}

export interface PreviewPerformanceSnapshot extends PreviewTiming {
  readonly detectLatencyMs?: number;
  readonly renderLatencyMs?: number;
  readonly totalLatencyMs?: number;
}

/** In-memory timing only. This extension does not send telemetry. */
export class PerformanceTracker {
  private readonly timings = new Map<number, PreviewTiming>();
  private latest: PreviewPerformanceSnapshot | undefined;

  public detected(generation: number, detectedAt = Date.now()): void {
    this.timings.set(generation, { generation, detectedAt });
  }

  public refreshing(generation: number, timestamp = Date.now()): void {
    this.update(generation, { debounceCompletedAt: timestamp });
  }

  public captured(generation: number, captureLatencyMs: number, timestamp = Date.now()): PreviewPerformanceSnapshot {
    return this.update(generation, { capturedAt: timestamp, captureLatencyMs });
  }

  public rendered(generation: number, timestamp = Date.now()): PreviewPerformanceSnapshot | undefined {
    const timing = this.timings.get(generation);
    if (!timing) {
      return undefined;
    }
    const snapshot = this.calculate({ ...timing, renderedAt: timestamp });
    this.timings.delete(generation);
    this.latest = snapshot;
    return snapshot;
  }

  public get latestSnapshot(): PreviewPerformanceSnapshot | undefined {
    return this.latest;
  }

  public pruneBefore(generation: number): void {
    for (const key of this.timings.keys()) {
      if (key < generation) {
        this.timings.delete(key);
      }
    }
  }

  private update(generation: number, changes: Partial<PreviewTiming>): PreviewPerformanceSnapshot {
    const existing = this.timings.get(generation) ?? { generation, detectedAt: Date.now() };
    const timing = { ...existing, ...changes };
    this.timings.set(generation, timing);
    const snapshot = this.calculate(timing);
    this.latest = snapshot;
    return snapshot;
  }

  private calculate(timing: PreviewTiming): PreviewPerformanceSnapshot {
    return {
      ...timing,
      detectLatencyMs:
        timing.debounceCompletedAt === undefined ? undefined : timing.debounceCompletedAt - timing.detectedAt,
      renderLatencyMs:
        timing.renderedAt === undefined || timing.capturedAt === undefined
          ? undefined
          : timing.renderedAt - timing.capturedAt,
      totalLatencyMs:
        timing.renderedAt === undefined ? undefined : timing.renderedAt - timing.detectedAt,
    };
  }
}
