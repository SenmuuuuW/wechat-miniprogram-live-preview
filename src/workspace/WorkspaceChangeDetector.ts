import * as vscode from "vscode";

export const MINI_PROGRAM_SOURCE_GLOB = "**/*.{wxml,wxss,js,ts,json,wxs}";
const EXCLUDED_GLOB = "**/{node_modules,.git,dist,build,miniprogram_npm}/**";

export type WorkspaceChangeKind = "save" | "create" | "change" | "delete";

export interface WorkspaceChangeEvent {
  readonly kind: WorkspaceChangeKind;
  readonly uri: vscode.Uri;
  readonly occurredAt: number;
}

export interface WorkspaceChangeDetectorOptions {
  readonly onChange: (event: WorkspaceChangeEvent) => void;
  readonly isRelevant?: (uri: vscode.Uri) => boolean;
}

/**
 * Feeds save events and external filesystem writes through one callback. VS Code's
 * file watcher is essential because agents often write from a terminal instead of
 * saving an open TextDocument.
 */
export class WorkspaceChangeDetector implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  public constructor(private readonly options: WorkspaceChangeDetectorOptions) {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, MINI_PROGRAM_SOURCE_GLOB),
        false,
        false,
        false,
      );
      this.disposables.push(
        watcher,
        watcher.onDidCreate((uri) => this.emit("create", uri)),
        watcher.onDidChange((uri) => this.emit("change", uri)),
        watcher.onDidDelete((uri) => this.emit("delete", uri)),
      );
    }

    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((document) => this.emit("save", document.uri)),
    );
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  private emit(kind: WorkspaceChangeKind, uri: vscode.Uri): void {
    if (this.disposed || !isMiniProgramSource(uri) || isExcluded(uri) || this.options.isRelevant?.(uri) === false) {
      return;
    }
    this.options.onChange({ kind, uri, occurredAt: Date.now() });
  }
}

function isMiniProgramSource(uri: vscode.Uri): boolean {
  return /\.(wxml|wxss|js|ts|json|wxs)$/i.test(uri.fsPath);
}

function isExcluded(uri: vscode.Uri): boolean {
  return /(?:^|[\\/])(node_modules|\.git|dist|build|miniprogram_npm)(?:[\\/]|$)/.test(uri.fsPath);
}

export { EXCLUDED_GLOB };
