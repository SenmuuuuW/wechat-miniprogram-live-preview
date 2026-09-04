import * as vscode from "vscode";

import { AutomatorClient, type AutomatorRuntime, type ScreenshotResult } from "../devtools/AutomatorClient";
import { DevToolsController } from "../devtools/DevToolsController";
import { PreviewError, errorMessage } from "../errors/PreviewError";
import type { RefreshContext } from "../refresh/RefreshScheduler";
import { PerformanceTracker } from "../telemetry/PerformanceTracker";
import type { PreviewConsumer, PreviewImage, PreviewViewState } from "../preview/PreviewProvider";
import type {
  InputPreviewMessage,
  ScrollPreviewMessage,
  TapPreviewMessage,
} from "../preview/PreviewMessages";
import type { PreviewSettings } from "../config/settings";
import { CoordinateMapper } from "../interaction/CoordinateMapper";
import { InteractionController } from "../interaction/InteractionController";
import type { PreviewInteraction, RuntimePoint, Size } from "../interaction/InteractionTypes";
import { RuntimeOperationScheduler, type RuntimeOperationSnapshot } from "../interaction/RuntimeOperationScheduler";

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
  private readonly interactionController: InteractionController;
  private readonly consumers = new Set<PreviewConsumer>();
  private readonly stateListeners = new Set<(state: PreviewViewState) => void>();
  private scheduler: RuntimeOperationScheduler<ScreenshotResult>;
  private disposed = false;
  private currentState: PreviewViewState = { state: "disconnected", label: "Disconnected" };
  private projectPath: string | undefined;
  /** Last committed image, replayed to consumers that attach after capture. */
  private latestImage: PreviewImage | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnecting = false;
  private reconnectAttempt = 0;
  private lastError: PreviewError | undefined;
  /** The active Automator input target is session-local and never belongs to a frame alone. */
  private typing = false;
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
    this.interactionController = new InteractionController({
      currentPage: () => this.client.currentInteractionPage(),
      navigateBack: () => this.client.navigateBack(),
      pageScrollTo: (scrollTop) => this.client.pageScrollTo(scrollTop),
    });
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
    if (this.latestImage) {
      consumer.showPreview(this.latestImage);
    }
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
      this.interactionController.resetForReconnect();
      this.attachRuntimeListeners(runtime, lifecycleGeneration, projectPath);
      this.reconnectAttempt = 0;
      this.lastError = undefined;
      this.setState({ state: "connected", label: "Connected" });
      this.scheduler.requestImmediateRefresh("initial");
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
    this.latestImage = undefined;
    this.typing = false;
    this.interactionController.clearInputTarget();
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
    return this.scheduler.requestImmediateRefresh(reason);
  }

  /** Queue an explicit runtime back operation and capture the resulting frame. */
  public back(): number | undefined {
    if (!this.isConnected) {
      return undefined;
    }
    return this.enqueueInteraction({ kind: "back" });
  }

  /** Leave keyboard capture mode without changing the real Mini Program value. */
  public exitTyping(): void {
    this.typing = false;
    this.interactionController.clearInputTarget();
    if (this.isConnected && this.scheduler.state === "idle") {
      this.setState(connectedState());
    }
  }

  /** Accepts a validated, generation-bound interaction from either preview surface. */
  public handleInteraction(message: TapPreviewMessage | ScrollPreviewMessage | InputPreviewMessage): number | undefined {
    if (!this.isConnected) {
      return undefined;
    }
    if (!this.latestImage || this.latestImage.generation !== message.generation) {
      this.showNotice("The preview changed before this interaction could be applied. Try again on the latest frame.");
      return undefined;
    }

    if (message.type === "input") {
      if (!this.typing) {
        this.showNotice("Select a real input or textarea in the preview before typing.");
        return undefined;
      }
      // Generation is checked at message receipt, when the Webview proves it
      // belongs to the frame the user can see. Once accepted, text belongs to
      // the active input session rather than that frame: an input capture
      // naturally publishes a newer frame before a rapid following keystroke
      // reaches the front of this serialized queue.
      return this.enqueueTypingInput(message.value);
    }

    return this.enqueueInteractionForCoordinates(message);
  }

  public sourceChanged(reason = "filesystem"): number | undefined {
    if (!this.options.settings.autoRefresh || !this.isConnected) {
      return undefined;
    }
    const generation = this.scheduler.requestRefresh(reason);
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
    this.scheduler.invalidate();
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
          this.interactionController.resetForReconnect();
          this.attachRuntimeListeners(runtime, lifecycleGeneration, projectPath);
          this.lastError = undefined;
          this.reconnectAttempt = 0;
          this.setState({ state: "connected", label: "Connected" });
          this.scheduler.requestImmediateRefresh("reconnect");
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
    this.latestImage = undefined;
    this.typing = false;
    this.interactionController.clearInputTarget();
    this.reconnecting = false;
    this.clearReconnectTimer();
    this.scheduler.dispose();
    this.client.detach();
    this.controller.dispose();
    this.consumers.clear();
    this.stateListeners.clear();
  }

  private createScheduler(): RuntimeOperationScheduler<ScreenshotResult> {
    return new RuntimeOperationScheduler<ScreenshotResult>({
      debounceMs: this.options.settings.refreshDelay,
      // AutomatorClient bounds the individual runtime calls. Avoid wrapping
      // the whole capture a second time, which would add an extra Promise turn
      // to every normal preview refresh.
      operationTimeoutMs: 0,
      capture: async (context) => {
        this.tracker.refreshing(context.generation);
        return this.client.capture({
          generation: context.generation,
          requestedAt: context.requestedAt,
          reasons: context.reasons,
          signal: context.signal,
          isCurrent: context.isCurrent,
          isStale: context.isStale,
        });
      },
      commit: async (result, context) => {
        const image: PreviewImage = {
          generation: context.generation,
          data: result.data,
          screenshotSize: result.screenshotSize,
          pagePath: result.pagePath,
          captureLatencyMs: result.captureLatencyMs,
        };
        this.latestImage = image;
        this.tracker.captured(context.generation, result.captureLatencyMs, result.capturedAt);
        this.setState(this.typing ? typingState() : connectedState());
        for (const consumer of this.consumers) {
          consumer.showPreview(image);
        }
      },
      onError: async (error) => {
        this.handleOperationError(error);
      },
      onStateChange: (snapshot) => this.handleSchedulerState(snapshot),
    });
  }

  private handleSchedulerState(snapshot: RuntimeOperationSnapshot): void {
    if (snapshot.state === "refreshing" && this.isConnected) {
      this.setState({ state: "updating", label: "Updating" });
    } else if (snapshot.state === "interacting" && this.isConnected) {
      this.setState({ state: "interacting", label: "Interacting" });
    } else if (snapshot.state === "idle" && this.isConnected && (this.currentState.state === "updating" || this.currentState.state === "interacting")) {
      this.setState(this.typing ? typingState() : connectedState());
    }
  }

  private enqueueInteractionForCoordinates(message: TapPreviewMessage | ScrollPreviewMessage): number {
    const kind = message.type;
    return this.scheduler.enqueueInteraction(kind, async () => {
      const coordinates = await this.resolveRuntimeCoordinates(message);
      const interaction: PreviewInteraction = message.type === "tap"
        ? { kind: "tap", point: coordinates.point }
        : {
          kind: "scroll",
          point: coordinates.point,
          deltaX: scaleScreenshotDelta(message.deltaX, coordinates.screenshotSize.width, coordinates.runtimeSize.width),
          deltaY: scaleScreenshotDelta(message.deltaY, coordinates.screenshotSize.height, coordinates.runtimeSize.height),
        };
      await this.performInteraction(interaction);
    });
  }

  private enqueueInteraction(interaction: PreviewInteraction, generation?: number): number {
    return this.scheduler.enqueueInteraction(interaction.kind, async () => {
      if (generation !== undefined) {
        this.requireCurrentImage(generation);
      }
      await this.performInteraction(interaction);
    });
  }

  private enqueueTypingInput(value: string): number {
    return this.scheduler.enqueueInteraction("input", async () => {
      await this.performInteraction({ kind: "input", value });
    });
  }

  private async performInteraction(interaction: PreviewInteraction): Promise<void> {
    const result = await this.interactionController.perform(interaction);
    this.typing = result.typing;
  }

  private async resolveRuntimeCoordinates(message: TapPreviewMessage | ScrollPreviewMessage): Promise<{
    readonly point: RuntimePoint;
    readonly screenshotSize: Size;
    readonly runtimeSize: Size;
  }> {
    const image = this.requireCurrentImage(message.generation);
    const screenshotSize = image.screenshotSize;
    if (!screenshotSize || !isUsableSize(screenshotSize)) {
      throw interactionUnsupported("This preview frame does not have valid screenshot dimensions.");
    }

    const systemInfo = await this.client.systemInfo();
    const runtimeSize = runtimeSizeFromSystemInfo(systemInfo);
    if (!runtimeSize) {
      throw interactionUnsupported("WeChat DevTools did not provide the runtime viewport size for this interaction.");
    }
    // Do not send an action for a frame that was replaced while systemInfo was in flight.
    this.requireCurrentImage(message.generation);
    const point = CoordinateMapper.mapScreenshotPointToRuntime(
      { x: message.screenshotX, y: message.screenshotY },
      screenshotSize,
      runtimeSize,
    );
    if (!point) {
      throw interactionUnsupported("The preview coordinate could not be mapped to the WeChat runtime.");
    }
    return { point, screenshotSize, runtimeSize };
  }

  private requireCurrentImage(generation: number): PreviewImage {
    const image = this.latestImage;
    if (!image || image.generation !== generation) {
      throw interactionUnsupported("The preview changed before this interaction could be applied. Try again on the latest frame.");
    }
    return image;
  }

  private handleOperationError(error: unknown): void {
    const previewError = PreviewError.from(error, "automation-unavailable");
    if (previewError.code === "interaction-unsupported") {
      this.showNotice(formatErrorForUser(previewError));
      if (this.isConnected) {
        this.setState(this.typing ? typingState() : connectedState());
      }
      return;
    }
    this.handleError(previewError);
  }

  private showNotice(message: string): void {
    for (const consumer of this.consumers) {
      consumer.showNotice?.(message);
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

  private attachRuntimeListeners(runtime: AutomatorRuntime, generation: number, projectPath: string): void {
    runtime.on?.("console", (payload) => {
      if (this.isCurrentRuntime(runtime, generation, projectPath)) {
        this.handleRuntimeLog(payload);
      }
    });
    runtime.on?.("exception", (payload) => {
      if (this.isCurrentRuntime(runtime, generation, projectPath)) {
        this.handleRuntimeException(payload);
      }
    });
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

  private isCurrentRuntime(runtime: AutomatorRuntime, generation: number, projectPath: string): boolean {
    return this.isCurrentLifecycle(generation, projectPath) && this.controller.currentRuntime === runtime;
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

function connectedState(): PreviewViewState {
  return { state: "connected", label: "Connected" };
}

function typingState(): PreviewViewState {
  return { state: "typing", label: "Typing" };
}

function interactionUnsupported(message: string): PreviewError {
  return new PreviewError("interaction-unsupported", message);
}

function isUsableSize(size: { readonly width: number; readonly height: number }): boolean {
  return Number.isFinite(size.width)
    && Number.isFinite(size.height)
    && size.width > 0
    && size.height > 0;
}

function runtimeSizeFromSystemInfo(
  systemInfo: { readonly windowWidth?: number; readonly windowHeight?: number },
): Size | undefined {
  const width = finitePositiveNumber(systemInfo.windowWidth);
  const height = finitePositiveNumber(systemInfo.windowHeight);
  return width && height ? { width, height } : undefined;
}

function finitePositiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function scaleScreenshotDelta(delta: number, screenshotDimension: number, runtimeDimension: number): number {
  if (!Number.isFinite(delta) || !isUsableDimension(screenshotDimension) || !isUsableDimension(runtimeDimension)) {
    return 0;
  }
  return Math.round(delta * runtimeDimension / screenshotDimension);
}

function isUsableDimension(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
