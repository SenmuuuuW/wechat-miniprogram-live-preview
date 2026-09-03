import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { PreviewError } from "../errors/PreviewError";

const execFileAsync = promisify(execFile);

export interface DevToolsLocatorFileSystem {
  executable(path: string): Promise<boolean>;
}

export interface DevToolsLocatorCommandRunner {
  findApplicationPaths(): Promise<readonly string[]>;
}

export interface DevToolsLocation {
  readonly cliPath: string;
  readonly source: "configured" | "known-location" | "system-discovery";
}

export interface DevToolsLocatorOptions {
  readonly configuredPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly fileSystem?: DevToolsLocatorFileSystem;
  readonly commandRunner?: DevToolsLocatorCommandRunner;
}

const macAppCandidates = [
  "/Applications/wechatwebdevtools.app",
  "/Applications/微信开发者工具.app",
  "/Applications/WechatDevTools.app",
];

const windowsCliCandidates = [
  "C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat",
  "C:\\Program Files\\Tencent\\微信web开发者工具\\cli.bat",
];

const nodeFileSystem: DevToolsLocatorFileSystem = {
  async executable(path: string): Promise<boolean> {
    try {
      const details = await stat(path);
      if (!details.isFile()) {
        return false;
      }
      await access(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
};

const systemCommandRunner: DevToolsLocatorCommandRunner = {
  async findApplicationPaths(): Promise<readonly string[]> {
    if (process.platform !== "darwin") {
      return [];
    }

    try {
      const { stdout } = await execFileAsync("mdfind", [
        'kMDItemCFBundleIdentifier == "com.tencent.webplusdevtools" || kMDItemCFBundleIdentifier == "com.tencent.wechatdevtools"',
      ]);
      return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    } catch {
      return [];
    }
  },
};

/** Resolves an Automator-compatible WeChat DevTools CLI without hard-coded user paths. */
export class DevToolsLocator {
  private readonly platform: NodeJS.Platform;
  private readonly fileSystem: DevToolsLocatorFileSystem;
  private readonly commandRunner: DevToolsLocatorCommandRunner;

  public constructor(options: DevToolsLocatorOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.fileSystem = options.fileSystem ?? nodeFileSystem;
    this.commandRunner = options.commandRunner ?? systemCommandRunner;
  }

  public async locate(configuredPath?: string): Promise<DevToolsLocation> {
    if (configuredPath?.trim()) {
      const cliPath = await this.resolveCliPath(configuredPath.trim());
      if (cliPath) {
        return { cliPath, source: "configured" };
      }
      throw new PreviewError(
        "devtools-not-found",
        `The configured WeChat DevTools path is not an executable CLI: ${configuredPath}`,
        { action: "Update miniProgramPreview.devtoolsPath." },
      );
    }

    for (const candidate of this.defaultCandidates()) {
      const cliPath = await this.resolveCliPath(candidate);
      if (cliPath) {
        return { cliPath, source: "known-location" };
      }
    }

    for (const applicationPath of await this.commandRunner.findApplicationPaths()) {
      const cliPath = await this.resolveCliPath(applicationPath);
      if (cliPath) {
        return { cliPath, source: "system-discovery" };
      }
    }

    throw new PreviewError(
      "devtools-not-found",
      "Unable to find the WeChat DevTools CLI. Install WeChat DevTools or set miniProgramPreview.devtoolsPath.",
      { action: "Install WeChat DevTools, then use Mini Program: Reconnect." },
    );
  }

  private defaultCandidates(): readonly string[] {
    if (this.platform === "darwin") {
      return macAppCandidates;
    }
    if (this.platform === "win32") {
      return windowsCliCandidates;
    }
    return [];
  }

  private async resolveCliPath(inputPath: string): Promise<string | undefined> {
    const normalized = inputPath.replace(/[\\/]$/, "");
    const candidates = [
      normalized,
      join(normalized, "Contents", "MacOS", "cli"),
      join(normalized, "cli"),
    ];

    for (const candidate of candidates) {
      if (await this.fileSystem.executable(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }
}
