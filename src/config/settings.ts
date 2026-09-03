import * as vscode from "vscode";

export interface PreviewSettings {
  readonly devtoolsPath: string | undefined;
  readonly projectPath: string | undefined;
  readonly autoRefresh: boolean;
  readonly refreshDelay: number;
  readonly automatorPort: number;
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
    automatorPort: normalizedInteger(configuration.get<number>("automatorPort", 9420), 9420, 1, 65535),
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
