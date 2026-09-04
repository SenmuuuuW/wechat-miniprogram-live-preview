import * as vscode from "vscode";

import type { PreviewConsumer, PreviewImage, PreviewProviderCallbacks, PreviewViewState } from "./PreviewProvider";
import { parsePreviewWebviewMessage } from "./PreviewMessages";
import { previewWebviewHtml } from "./webviewHtml";

/** Editor-area preview. It is a consumer of the same session as the sidebar. */
export class PreviewPanel implements vscode.Disposable, PreviewConsumer {
  private readonly disposables: vscode.Disposable[] = [];
  private consumerRegistration: vscode.Disposable | undefined;
  private disposed = false;
  private latestState: PreviewViewState = { state: "disconnected", label: "Disconnected" };
  private latestImage: PreviewImage | undefined;

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
    void this.panel.webview.postMessage(message);
  }
}
