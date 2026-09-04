import * as vscode from "vscode";

import {
  parsePreviewWebviewMessage,
  type InputPreviewMessage,
  type ScrollPreviewMessage,
  type TapPreviewMessage,
} from "./PreviewMessages";
import { previewWebviewHtml } from "./webviewHtml";

export interface PreviewViewState {
  readonly state: "disconnected" | "connecting" | "connected" | "updating" | "interacting" | "typing" | "error";
  readonly label: string;
  readonly error?: string;
}

export interface PreviewImage {
  readonly generation: number;
  readonly data: string;
  /** Real PNG dimensions used to bind Webview interactions to this exact frame. */
  readonly screenshotSize?: { readonly width: number; readonly height: number };
  readonly pagePath: string | undefined;
  readonly captureLatencyMs: number;
}

export interface PreviewConsumer {
  updateState(state: PreviewViewState): void;
  showPreview(image: PreviewImage): void;
  showError(message: string): void;
  /** A recoverable runtime limitation which must not discard the valid frame. */
  showNotice?(message: string): void;
  dispose(): void;
}

export interface PreviewProviderCallbacks {
  readonly onReconnect: () => void;
  readonly onRendered: (generation: number) => void;
  readonly onRefresh?: () => void;
  readonly onBack?: () => void;
  readonly onExitTyping?: () => void;
  readonly onInteraction?: (message: TapPreviewMessage | ScrollPreviewMessage | InputPreviewMessage) => void;
}

/** Sidebar view wrapper. It contains no DevTools connection of its own. */
export class PreviewProvider implements vscode.WebviewViewProvider, vscode.Disposable, PreviewConsumer {
  public static readonly viewType = "miniProgramPreview.sidebar";
  private view: vscode.WebviewView | undefined;
  private latestState: PreviewViewState = { state: "disconnected", label: "Disconnected" };
  private latestImage: PreviewImage | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private viewDisposables: vscode.Disposable[] = [];

  public constructor(private readonly callbacks: PreviewProviderCallbacks) {}

  public resolveWebviewView(view: vscode.WebviewView): void {
    for (const disposable of this.viewDisposables.splice(0)) {
      disposable.dispose();
    }
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = previewWebviewHtml(view.webview, "Mini Program Preview");
    this.viewDisposables.push(
      view.webview.onDidReceiveMessage((message) => this.handleMessage(message)),
      view.onDidDispose(() => {
        for (const disposable of this.viewDisposables.splice(0)) {
          disposable.dispose();
        }
        if (this.view === view) {
          this.view = undefined;
        }
      }),
    );
  }

  public updateState(state: PreviewViewState): void {
    this.latestState = state;
    this.post({ type: "state", ...state });
  }

  public showPreview(image: PreviewImage): void {
    this.latestImage = image;
    this.post({ type: "preview", ...image });
  }

  public showError(message: string): void {
    this.post({ type: "error", message });
  }

  public showNotice(message: string): void {
    this.post({ type: "notice", message });
  }

  public dispose(): void {
    for (const disposable of this.viewDisposables.splice(0)) {
      disposable.dispose();
    }
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.view = undefined;
  }

  private handleMessage(message: unknown): void {
    const parsed = parsePreviewWebviewMessage(message);
    if (!parsed) {
      return;
    }
    switch (parsed.type) {
      case "reconnect":
        this.callbacks.onReconnect();
        return;
      case "refresh":
        this.callbacks.onRefresh?.();
        return;
      case "back":
        this.callbacks.onBack?.();
        return;
      case "exitTyping":
        this.callbacks.onExitTyping?.();
        return;
      case "tap":
      case "scroll":
      case "input":
        this.callbacks.onInteraction?.(parsed);
        return;
      case "previewRendered":
        this.callbacks.onRendered(parsed.generation);
        return;
      case "ready":
        this.post({ type: "state", ...this.latestState });
        if (this.latestImage) {
          this.post({ type: "preview", ...this.latestImage });
        }
        return;
    }
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }
}
