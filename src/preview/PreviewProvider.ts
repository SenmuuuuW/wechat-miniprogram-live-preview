import * as vscode from "vscode";

import { previewWebviewHtml } from "./webviewHtml";

export interface PreviewViewState {
  readonly state: "disconnected" | "connecting" | "connected" | "updating" | "error";
  readonly label: string;
  readonly error?: string;
}

export interface PreviewImage {
  readonly generation: number;
  readonly data: string;
  readonly pagePath: string | undefined;
  readonly captureLatencyMs: number;
}

export interface PreviewConsumer {
  updateState(state: PreviewViewState): void;
  showPreview(image: PreviewImage): void;
  showError(message: string): void;
  dispose(): void;
}

export interface PreviewProviderCallbacks {
  readonly onReconnect: () => void;
  readonly onRendered: (generation: number) => void;
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
    if (!isMessage(message)) {
      return;
    }
    if (message.type === "reconnect") {
      this.callbacks.onReconnect();
      return;
    }
    if (message.type === "previewRendered" && typeof message.generation === "number") {
      this.callbacks.onRendered(message.generation);
      return;
    }
    if (message.type === "ready") {
      this.post({ type: "state", ...this.latestState });
      if (this.latestImage) {
        this.post({ type: "preview", ...this.latestImage });
      }
    }
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }
}

function isMessage(value: unknown): value is { type: string; generation?: unknown } {
  return typeof value === "object" && value !== null && "type" in value;
}
