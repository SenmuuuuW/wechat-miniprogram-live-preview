import * as vscode from "vscode";

import { AutomatorClient, type AutomatorRuntime, type ScreenshotResult } from "../devtools/AutomatorClient";
import { DevToolsController } from "../devtools/DevToolsController";
import { PreviewError, errorMessage } from "../errors/PreviewError";
import {
  RefreshScheduler,
  type RefreshContext,
  type RefreshSchedulerSnapshot,
} from "../refresh/RefreshScheduler";
import { PerformanceTracker } from "../telemetry/PerformanceTracker";
import type { PreviewConsumer, PreviewImage, PreviewViewState } from "../preview/PreviewProvider";
import type { PreviewSettings } from "../config/settings";

export type PreviewSessionState = PreviewViewState["state"];

export interface PreviewSessionOptions {
  readonly settings: PreviewSettings;
  readonly controller?: DevToolsController;
  readonly client?: AutomatorClient;
  readonly tracker?: PerformanceTracker;
}

/** One project, one DevTools connection, and multiple UI consumers. */
export class PreviewSession implements vscode.Disposable {
  private readonly controller: DevToolsController;
  private readonly client: AutomatorClient;
  private readonly tracker: PerformanceTracker;
  private readonly consumers = new Set<PreviewConsumer>();
  private readonly stateListeners = new Set<(state: PreviewViewState) => void>();
  private scheduler: RefreshScheduler<ScreenshotResult>;
  private disposed = false;
  private currentState: PreviewViewState = { state: "disconnected", label: "Disconnected" };
  private projectPath: string | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnecting = false;
  private reconnectAttempt = 0;
  private lastError: PreviewError | undefined;
  /** Invalidates asynchronous starts/reconnects when the session is stopped or replaced. */
  private lifecycleGeneration = 0;

  public constructor(private readonly options: PreviewSessionOptions) {
    this.controller = options.controller ?? new DevToolsController({
      port: options.settings.automatorPort,
      launchDevTools: options.settings.launchDevTools,
    });
    this.client = options.client ?? new AutomatorClient({
      captureDelayMs: options.settings.captureDelay,
      maxAttempts: options.settings.maxRefreshRetries,
    });
    this.tracker = options.tracker ?? new PerformanceTracker();
    this.scheduler = this.createScheduler();
  }

  public get state(): PreviewViewState {
    return this.currentState;
  }

  public get isConnected(): boolean {
    return this.controller.connected;
  }

  public get currentProjectPath(): string | undefined {
    return this.projectPath;
  }

  public get latestPerformance() {
    return this.tracker.latestSnapshot;
  }

  public attachConsumer(consumer: PreviewConsumer): vscode.Disposable {
    this.consumers.add(consumer);
    consumer.updateState(this.currentState);
    return { dispose: () => this.consumers.delete(consumer) };
  }

  public onStateChange(listener: (state: PreviewViewState) => void): vscode.Disposable {
    this.stateListeners.add(listener);
    return { dispose: () => this.stateListeners.delete(listener) };
  }

  public async start(projectPath: string, configuredDevtoolsPath?: string): Promise<void> {
    if (this.disposed) {
      return;
    }

    // Starting always replaces the previous session, including an errored session
    // that may still have a reconnect timer or in-flight reconnect attempt.
    this.stop();
    const lifecycleGeneration = ++this.lifecycleGeneration;
    this.projectPath = projectPath;
    this.clearReconnectTimer();
    this.setState({ state: "connecting", label: "Connecting" });
    try {
      const runtime = await this.controller.start({ projectPath, configuredPath: configuredDevtoolsPath });

      if (!this.isCurrentLifecycle(lifecycleGeneration, projectPath)) {
        this.discardRuntime(runtime);
        return;
      }

      this.client.attach(runtime);
      runtime.on?.("console", (payload) => this.handleRuntimeLog(payload));
      runtime.on?.("exception", (payload) => this.handleRuntimeException(payload));
      this.reconnectAttempt = 0;
      this.lastError = undefined;
      this.setState({ state: "connected", label: "Connected" });
      this.scheduler.requestImmediate("initial");
    } catch (error) {
      // A stop/new start/dispose deliberately supersedes this request. Its failure
      // belongs to the obsolete caller and must not replace the current UI state.
      if (!this.isCurrentLifecycle(lifecycleGeneration, projectPath)) {
        return;
      }
      this.handleError(error);
      throw error;
    }
  }

  public stop(): void {
    if (this.disposed) {
      return;
    }

    this.lifecycleGeneration += 1;
    this.projectPath = undefined;
    this.reconnecting = false;
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.lastError = undefined;
    this.scheduler.dispose();
    this.client.detach();
    this.controller.disconnect({ clearLastStart: true });
    this.scheduler = this.createScheduler();
    this.setState({ state: "disconnected", label: "Disconnected" });
  }

  public refresh(reason = "manual"): number {
    return this.scheduler.requestImmediate(reason);
  }

  public sourceChanged(reason = "filesystem"): number | undefined {
    if (!this.options.settings.autoRefresh || !this.isConnected) {
      return undefined;
    }
    const generation = this.scheduler.request(reason);
    this.tracker.detected(generation);
    return generation;
  }

  public async reconnect(): Promise<void> {
    if (this.disposed || this.reconnecting || !this.projectPath) {
      return;
    }

    const lifecycleGeneration = ++this.lifecycleGeneration;
    const projectPath = this.projectPath;
    this.reconnecting = true;
    this.clearReconnectTimer();
    try {
      const maxAttempts = 4;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (!this.isCurrentLifecycle(lifecycleGeneration, projectPath)) {
          return;
        }
        this.reconnectAttempt = attempt + 1;
        this.setState({
          state: "connecting",
          label: `Connecting (attempt ${this.reconnectAttempt}/${maxAttempts})`,
        });
        try {
          const runtime = await this.controller.reconnect();

          if (!this.isCurrentLifecycle(lifecycleGeneration, projectPath)) {
            this.discardRuntime(runtime);
            return;
          }

          this.client.attach(runtime);
          runtime.on?.("console", (payload) => this.handleRuntimeLog(payload));
          runtime.on?.("exception", (payload) => this.handleRuntimeException(payload));
          this.lastError = undefined;
          this.reconnectAttempt = 0;
          this.setState({ state: "connected", label: "Connected" });
          this.scheduler.requestImmediate("reconnect");
          return;
        } catch (error) {
          if (!this.isCurrentLifecycle(lifecycleGeneration, projectPath)) {
            return;
          }
          this.lastError = PreviewError.from(error, "automation-unavailable");
          if (attempt === maxAttempts - 1) {
            this.handleError(this.lastError);
            return;
          }
          await wait(2 ** attempt * 1000);
        }
      }
    } finally {
      if (this.lifecycleGeneration === lifecycleGeneration) {
        this.reconnecting = false;
      }
    }
  }

  public notifyRendered(generation: number): void {
    this.tracker.rendered(generation);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.lifecycleGeneration += 1;
    this.projectPath = undefined;
    this.reconnecting = false;
    this.clearReconnectTimer();
    this.scheduler.dispose();
    this.client.detach();
    this.controller.dispose();
    this.consumers.clear();
    this.stateListeners.clear();
  }

  private createScheduler(): RefreshScheduler<ScreenshotResult> {
    return new RefreshScheduler<ScreenshotResult>({
      debounceMs: this.options.settings.refreshDelay,
      perform: async (context) => {
        this.tracker.refreshing(context.generation);
        return this.client.capture(context);
      },
      commit: async (result, context) => {
        const image: PreviewImage = {
          generation: context.generation,
          data: result.data,
          pagePath: result.pagePath,
          captureLatencyMs: result.captureLatencyMs,
        };
        this.tracker.captured(context.generation, result.captureLatencyMs, result.capturedAt);
        this.setState({ state: "connected", label: "Connected" });
        for (const consumer of this.consumers) {
          consumer.showPreview(image);
        }
      },
      onError: async (error) => {
        this.handleError(error);
      },
      onStateChange: (snapshot) => this.handleSchedulerState(snapshot),
    });
  }

  private handleSchedulerState(snapshot: RefreshSchedulerSnapshot): void {
    if (snapshot.state === "refreshing" && this.isConnected) {
      this.setState({ state: "updating", label: "Updating" });
    } else if (snapshot.state === "idle" && this.isConnected && this.currentState.state === "updating") {
      this.setState({ state: "connected", label: "Connected" });
    }
  }

  private handleError(error: unknown): void {
    const previewError = PreviewError.from(error, "automation-unavailable");
    this.lastError = previewError;
    this.setState({ state: "error", label: "Error", error: previewError.message });
    for (const consumer of this.consumers) {
      consumer.showError(formatErrorForUser(previewError));
    }
    if (previewError.code === "runtime-disconnected" && this.options.settings.autoReconnect) {
      this.scheduleReconnect();
    }
  }

  private handleRuntimeLog(payload: unknown): void {
    // Runtime logs are intentionally not surfaced as failures. They remain available
    // through the Automator event stream for a future diagnostics panel.
    void payload;
  }

  private handleRuntimeException(payload: unknown): void {
    const message = extractRuntimeMessage(payload);
    if (message) {
      this.handleError(new PreviewError("runtime-exception", `Runtime exception: ${message}`));
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnecting || this.reconnectTimer || !this.projectPath || this.disposed) {
      return;
    }
    const delay = 2 ** Math.min(this.reconnectAttempt, 3) * 1000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private isCurrentLifecycle(generation: number, projectPath: string): boolean {
    return !this.disposed && generation === this.lifecycleGeneration && this.projectPath === projectPath;
  }

  private discardRuntime(runtime: AutomatorRuntime): void {
    if (this.controller.currentRuntime === runtime) {
      this.controller.disconnect({ clearLastStart: true });
      return;
    }

    try {
      runtime.disconnect();
    } catch {
      // A stale runtime may already have been disconnected by the controller.
    }
  }

  private setState(state: PreviewViewState): void {
    if (this.currentState.state === state.state && this.currentState.label === state.label && this.currentState.error === state.error) {
      return;
    }
    this.currentState = state;
    for (const consumer of this.consumers) {
      consumer.updateState(state);
    }
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch {
        // A UI observer must not break the shared runtime session.
      }
    }
  }
}

function formatErrorForUser(error: PreviewError): string {
  if (error.action) {
    return `${error.message} ${error.action}`;
  }
  return error.message;
}

function extractRuntimeMessage(payload: unknown): string | undefined {
  if (typeof payload === "string") {
    return payload;
  }
  if (typeof payload === "object" && payload !== null && "message" in payload) {
    const value = (payload as { message?: unknown }).message;
    return typeof value === "string" ? value : errorMessage(value);
  }
  return payload === undefined ? undefined : errorMessage(payload);
}

async function wait(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}
