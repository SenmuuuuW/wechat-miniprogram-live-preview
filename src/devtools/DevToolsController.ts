import type { ILaunchOptions } from "miniprogram-automator/out/Launcher";

import { DevToolsLocator } from "./DevToolsLocator";
import type { AutomatorRuntime } from "./AutomatorClient";
import { PreviewError, errorMessage } from "../errors/PreviewError";

export interface AutomatorFactory {
  launch(options: ILaunchOptions): Promise<AutomatorRuntime>;
  connect(options: { wsEndpoint: string }): Promise<AutomatorRuntime>;
}

export interface DevToolsControllerOptions {
  readonly locator?: DevToolsLocator;
  readonly factory?: AutomatorFactory;
  readonly port?: number;
  readonly launchDevTools?: boolean;
}

export interface DevToolsStartOptions {
  readonly projectPath: string;
  readonly configuredPath?: string;
}

export interface DevToolsDisconnectOptions {
  /** Forget the project used by reconnect after disconnecting the runtime. */
  readonly clearLastStart?: boolean;
}

export type DevToolsControllerState = "disconnected" | "connecting" | "connected" | "error";

const defaultFactory: AutomatorFactory = {
  async launch(options) {
    const module = await import("miniprogram-automator");
    return module.default.launch(options) as unknown as AutomatorRuntime;
  },
  async connect(options) {
    const module = await import("miniprogram-automator");
    return module.default.connect(options) as unknown as AutomatorRuntime;
  },
};

/** Owns one Automator runtime. It never kills a DevTools process on dispose. */
export class DevToolsController {
  private readonly locator: DevToolsLocator;
  private readonly factory: AutomatorFactory;
  private readonly port: number;
  private readonly launchDevTools: boolean;
  private runtime: AutomatorRuntime | undefined;
  private lastStart: DevToolsStartOptions | undefined;
  private currentState: DevToolsControllerState = "disconnected";
  /** Invalidates connection attempts that are no longer the active request. */
  private startGeneration = 0;

  public constructor(options: DevToolsControllerOptions = {}) {
    this.locator = options.locator ?? new DevToolsLocator();
    this.factory = options.factory ?? defaultFactory;
    this.port = normalizePort(options.port);
    this.launchDevTools = options.launchDevTools ?? true;
  }

  public get state(): DevToolsControllerState {
    return this.currentState;
  }

  public get connected(): boolean {
    return this.runtime !== undefined;
  }

  public get currentRuntime(): AutomatorRuntime | undefined {
    return this.runtime;
  }

  public async start(options: DevToolsStartOptions): Promise<AutomatorRuntime> {
    const generation = ++this.startGeneration;
    this.lastStart = options;
    this.setState("connecting");
    try {
      const runtime = this.launchDevTools
        ? await this.launch(options)
        : await this.factory.connect({ wsEndpoint: `ws://127.0.0.1:${this.port}` });

      // A newer start/disconnect may have superseded this asynchronous launch.
      // Do not install an obsolete runtime or change the newer connection state.
      if (generation !== this.startGeneration) {
        disconnectRuntime(runtime);
        throw new PreviewError("runtime-disconnected", "The DevTools connection was superseded by a newer request.");
      }

      this.runtime = runtime;
      this.setState("connected");
      return runtime;
    } catch (error) {
      if (generation !== this.startGeneration) {
        throw error;
      }
      this.runtime = undefined;
      this.setState("error");
      throw toPreviewError(error);
    }
  }

  public async reconnect(): Promise<AutomatorRuntime> {
    if (!this.lastStart) {
      throw new PreviewError("project-not-found", "No Mini Program project has been started yet.");
    }
    const lastStart = this.lastStart;
    this.disconnect();
    return this.start(lastStart);
  }

  public disconnect(options: DevToolsDisconnectOptions = {}): void {
    // Invalidate any pending launch/connect before tearing down the current runtime.
    this.startGeneration += 1;
    const runtime = this.runtime;
    this.runtime = undefined;
    if (options.clearLastStart) {
      this.lastStart = undefined;
    }
    if (runtime) {
      disconnectRuntime(runtime);
    }
    this.setState("disconnected");
  }

  public dispose(): void {
    this.disconnect({ clearLastStart: true });
  }

  private async launch(options: DevToolsStartOptions): Promise<AutomatorRuntime> {
    const location = await this.locator.locate(options.configuredPath);
    return this.factory.launch({
      cliPath: location.cliPath,
      projectPath: options.projectPath,
      port: this.port,
      trustProject: true,
    });
  }

  private setState(state: DevToolsControllerState): void {
    this.currentState = state;
  }
}

function disconnectRuntime(runtime: AutomatorRuntime): void {
  try {
    runtime.disconnect();
  } catch {
    // A closed socket is already disconnected.
  }
}

function normalizePort(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 9420;
  }
  return Math.min(65535, Math.max(1, Math.floor(value)));
}

function toPreviewError(error: unknown): PreviewError {
  const message = errorMessage(error);
  if (/invalid[_ ]login|access[_ ]token[^\n]*(?:expired|invalid)|(?:not|needs?|requires?)\s+(?:to\s+be\s+)?logged\s+in|unauthenticated|unauthorized/i.test(message)) {
    return new PreviewError(
      "login-required",
      "WeChat DevTools login is required before opening this Mini Program.",
      { cause: error, action: "Sign in to WeChat DevTools, then run Reconnect." },
    );
  }
  if (/port|listen|service port|automation/i.test(message)) {
    return new PreviewError(
      "automation-unavailable",
      "Unable to connect to WeChat DevTools automation. Enable Service Port/automation in DevTools and retry.",
      { cause: error, action: "Open WeChat DevTools settings and enable Service Port, then run Reconnect." },
    );
  }
  if (/project path|doesn't exist|project/i.test(message)) {
    return new PreviewError("project-not-found", message, { cause: error });
  }
  return PreviewError.from(error, "automation-unavailable");
}
