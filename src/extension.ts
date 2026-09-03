import * as vscode from "vscode";

import { getPreviewSettings } from "./config/settings";
import { PreviewError } from "./errors/PreviewError";
import { PreviewPanel } from "./preview/PreviewPanel";
import { PreviewProvider } from "./preview/PreviewProvider";
import { ProjectDetector, type ProjectCandidate } from "./project/ProjectDetector";
import { PreviewSession } from "./session/PreviewSession";
import { WorkspaceChangeDetector } from "./workspace/WorkspaceChangeDetector";

let activeSession: PreviewSession | undefined;
let activeProvider: PreviewProvider | undefined;
let activePanel: PreviewPanel | undefined;
let changeDetector: WorkspaceChangeDetector | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  activeSession = new PreviewSession({ settings: getPreviewSettings() });
  activeProvider = new PreviewProvider({
    onReconnect: () => void reconnectPreview(),
    onRendered: (generation) => activeSession?.notifyRendered(generation),
  });
  context.subscriptions.push(
    activeSession,
    activeProvider,
    vscode.window.registerWebviewViewProvider(PreviewProvider.viewType, activeProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  activeSession.attachConsumer(activeProvider);

  changeDetector = new WorkspaceChangeDetector({
    onChange: (event) => {
      activeSession?.sourceChanged(`${event.kind}:${event.uri.path}`);
    },
  });
  context.subscriptions.push(changeDetector);

  context.subscriptions.push(
    vscode.commands.registerCommand("miniProgramPreview.start", () => startPreview()),
    vscode.commands.registerCommand("miniProgramPreview.stop", () => stopPreview()),
    vscode.commands.registerCommand("miniProgramPreview.refresh", () => activeSession?.refresh()),
    vscode.commands.registerCommand("miniProgramPreview.open", () => openPreview()),
    vscode.commands.registerCommand("miniProgramPreview.reconnect", () => reconnectPreview()),
  );
}

export function deactivate(): void {
  activePanel?.dispose();
  activePanel = undefined;
  changeDetector?.dispose();
  changeDetector = undefined;
  activeSession?.dispose();
  activeSession = undefined;
  activeProvider?.dispose();
  activeProvider = undefined;
}

async function startPreview(): Promise<void> {
  if (!activeSession) {
    return;
  }
  try {
    const candidate = await chooseProject();
    if (!candidate) {
      return;
    }
    const settings = getPreviewSettings();
    await activeSession.start(candidate.rootPath, settings.devtoolsPath);
    void vscode.window.showInformationMessage(`Mini Program preview started: ${candidate.relativePath}`);
  } catch (error) {
    await showPreviewError(error);
  }
}

function stopPreview(): void {
  activeSession?.stop();
  void vscode.window.showInformationMessage("Mini Program preview stopped.");
}

function openPreview(): void {
  if (!activeSession) {
    return;
  }
  activePanel?.dispose();
  activePanel = PreviewPanel.create({
    onReconnect: () => void reconnectPreview(),
    onRendered: (generation) => activeSession?.notifyRendered(generation),
  });
  activePanel.attachToSession(activeSession.attachConsumer(activePanel));
  activePanel.reveal();
}

async function reconnectPreview(): Promise<void> {
  try {
    await activeSession?.reconnect();
  } catch (error) {
    await showPreviewError(error);
  }
}

async function chooseProject(): Promise<ProjectCandidate | undefined> {
  const detector = new ProjectDetector();
  const folders = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
  const result = await detector.detect({
    workspaceFolders: folders,
    configuredProjectPath: getPreviewSettings().projectPath,
  });

  if (result.kind === "selected") {
    return result.candidate;
  }
  if (result.kind === "not-found") {
    throw new PreviewError(
      "project-not-found",
      "No project.config.json was found in the current workspace.",
      { action: "Open a Mini Program workspace or set miniProgramPreview.projectPath." },
    );
  }
  if (result.kind === "invalid-configured-path") {
    throw new PreviewError(
      "invalid-configuration",
      result.diagnostics[0]?.message ?? "The configured Mini Program project path is invalid.",
      { action: "Update miniProgramPreview.projectPath." },
    );
  }

  const selection = await vscode.window.showQuickPick(
    result.candidates.map((candidate) => ({
      label: candidate.relativePath,
      description: candidate.rootPath,
      candidate,
    })),
    { placeHolder: "Select a Mini Program project" },
  );
  return selection?.candidate;
}

async function showPreviewError(error: unknown): Promise<void> {
  const previewError = PreviewError.from(error, "unknown");
  const action = previewError.action ? ` ${previewError.action}` : "";
  const selection = await vscode.window.showErrorMessage(
    `${previewError.message}${action}`,
    "Retry",
    "Open Settings",
  );
  if (selection === "Retry") {
    void startPreview();
  } else if (selection === "Open Settings") {
    await vscode.commands.executeCommand("workbench.action.openSettings", "miniProgramPreview");
  }
}
