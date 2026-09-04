import * as vscode from "vscode";

export interface PreviewSettings {
  readonly devtoolsPath: string | undefined;
  readonly projectPath: string | undefined;
  readonly autoRefresh: boolean;
  readonly refreshDelay: number;
  readonly automatorPort: number | undefined;
  readonly launchDevTools: boolean;
  readonly autoReconnect: boolean;
  readonly captureDelay: number;
  readonly maxRefreshRetries: number;
}

const CONFIGURATION_SECTION = "miniProgramPreview";

export function getPreviewSettings(): PreviewSettings {
  const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
  return {
    devtoolsPath: nonEmpty(configuration.get<string>("devtoolsPath", "")),
    projectPath: nonEmpty(configuration.get<string>("projectPath", "")),
    autoRefresh: configuration.get<boolean>("autoRefresh", true),
    refreshDelay: normalizedInteger(configuration.get<number>("refreshDelay", 350), 350, 0),
    automatorPort: normalizedPort(configuration.get<number>("automatorPort", 0)),
    launchDevTools: configuration.get<boolean>("launchDevTools", true),
    autoReconnect: configuration.get<boolean>("autoReconnect", true),
    captureDelay: normalizedInteger(configuration.get<number>("captureDelay", 180), 180, 0),
    maxRefreshRetries: normalizedInteger(
      configuration.get<number>("maxRefreshRetries", 3),
      3,
      1,
      8,
    ),
  };
}

function normalizedPort(value: number): number | undefined {
  if (!Number.isFinite(value) || value === 0) return undefined;
  return Math.min(65535, Math.max(1, Math.floor(value)));
}

function nonEmpty(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizedInteger(value: number, fallback: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}
