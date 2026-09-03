import * as vscode from "vscode";

import type { PreviewConsumer, PreviewImage, PreviewProviderCallbacks, PreviewViewState } from "./PreviewProvider";
import { previewWebviewHtml } from "./webviewHtml";

/** Editor-area preview. It is a consumer of the same session as the sidebar. */
export class PreviewPanel implements vscode.Disposable, PreviewConsumer {
  private readonly disposables: vscode.Disposable[] = [];
  private consumerRegistration: vscode.Disposable | undefined;
  private disposed = false;

  public static create(callbacks: PreviewProviderCallbacks): PreviewPanel {
    const panel = vscode.window.createWebviewPanel(
      "miniProgramPreview.panel",
      "Mini Program Preview",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    return new PreviewPanel(panel, callbacks);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly callbacks: PreviewProviderCallbacks,
  ) {
    panel.webview.html = previewWebviewHtml(panel.webview, "Mini Program Preview");
    this.disposables.push(
      panel.webview.onDidReceiveMessage((message) => this.handleMessage(message)),
      panel.onDidDispose(() => this.dispose()),
    );
  }

  public reveal(): void {
    this.panel.reveal(this.panel.viewColumn, true);
  }

  public attachToSession(registration: vscode.Disposable): void {
    if (this.disposed) {
      registration.dispose();
      return;
    }
    this.consumerRegistration?.dispose();
    this.consumerRegistration = registration;
  }

  public updateState(state: PreviewViewState): void {
    this.post({ type: "state", ...state });
  }

  public showPreview(image: PreviewImage): void {
    this.post({ type: "preview", ...image });
  }

  public showError(message: string): void {
    this.post({ type: "error", message });
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.consumerRegistration?.dispose();
    this.consumerRegistration = undefined;
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.panel.dispose();
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
    }
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }
}

function isMessage(value: unknown): value is { type: string; generation?: unknown } {
  return typeof value === "object" && value !== null && "type" in value;
}
