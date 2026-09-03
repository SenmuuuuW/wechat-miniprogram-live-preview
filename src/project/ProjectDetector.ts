import { readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const PROJECT_CONFIG_FILE = "project.config.json";

const DEFAULT_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "build",
  "dist",
  "miniprogram_npm",
  "node_modules",
]);

export interface ProjectDirectoryEntry {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink?(): boolean;
}

export interface ProjectFileStats {
  isDirectory(): boolean;
  isFile(): boolean;
}

/**
 * The small filesystem surface used by ProjectDetector. Keeping it injectable
 * makes project discovery testable without a VS Code workspace or disk fixtures.
 */
export interface ProjectFileSystem {
  readDirectory(directoryPath: string): Promise<readonly ProjectDirectoryEntry[]>;
  stat(targetPath: string): Promise<ProjectFileStats>;
  realpath?(targetPath: string): Promise<string>;
}

export interface ProjectDetectorDependencies {
  readonly fileSystem?: ProjectFileSystem;
  readonly excludedDirectoryNames?: readonly string[];
}

export interface ProjectDetectionOptions {
  /** Absolute or relative workspace folder paths. */
  readonly workspaceFolders: readonly string[];
  /**
   * An explicit project directory or project.config.json file. A relative value
   * is resolved against each workspace folder; an ambiguous value is rejected.
   */
  readonly configuredProjectPath?: string | undefined;
}

export interface ProjectCandidate {
  /** Directory containing project.config.json. */
  readonly rootPath: string;
  readonly configPath: string;
  /** The workspace folder that supplied this candidate, if there is one. */
  readonly workspacePath: string | undefined;
  /** A UI-friendly path relative to workspacePath, or the absolute root path. */
  readonly relativePath: string;
}

export interface ProjectDetectorDiagnostic {
  readonly code:
    | "ambiguous-configured-path"
    | "invalid-configured-path"
    | "unreadable-directory";
  readonly path: string;
  readonly message: string;
}

export type ProjectDetectionResult =
  | {
      readonly kind: "not-found";
      readonly candidates: readonly ProjectCandidate[];
      readonly diagnostics: readonly ProjectDetectorDiagnostic[];
    }
  | {
      readonly kind: "selected";
      readonly source: "auto" | "configured";
      readonly candidate: ProjectCandidate;
      readonly candidates: readonly ProjectCandidate[];
      readonly diagnostics: readonly ProjectDetectorDiagnostic[];
    }
  | {
      readonly kind: "multiple";
      readonly candidates: readonly ProjectCandidate[];
      readonly diagnostics: readonly ProjectDetectorDiagnostic[];
    }
  | {
      readonly kind: "invalid-configured-path";
      readonly configuredProjectPath: string;
      readonly candidates: readonly ProjectCandidate[];
      readonly diagnostics: readonly ProjectDetectorDiagnostic[];
    };

const nodeFileSystem: ProjectFileSystem = {
  readDirectory: async (directoryPath) => readdir(directoryPath, { withFileTypes: true }),
  stat,
  realpath,
};

/**
 * Finds Mini Program roots without parsing project.config.json. A temporarily
 * invalid JSON file is still a project and should be reported by DevTools later.
 */
export class ProjectDetector {
  private readonly fileSystem: ProjectFileSystem;
  private readonly excludedDirectoryNames: ReadonlySet<string>;

  public constructor(dependencies: ProjectDetectorDependencies = {}) {
    this.fileSystem = dependencies.fileSystem ?? nodeFileSystem;
    this.excludedDirectoryNames = new Set(
      dependencies.excludedDirectoryNames ?? DEFAULT_EXCLUDED_DIRECTORIES,
    );
  }

  public async detect(options: ProjectDetectionOptions): Promise<ProjectDetectionResult> {
    const workspaceFolders = uniqueResolvedPaths(options.workspaceFolders);
    const configuredProjectPath = options.configuredProjectPath?.trim();

    if (configuredProjectPath) {
      return this.detectConfiguredProject(configuredProjectPath, workspaceFolders);
    }

    const diagnostics: ProjectDetectorDiagnostic[] = [];
    const candidates = await this.discoverCandidates(workspaceFolders, diagnostics);

    if (candidates.length === 0) {
      return { kind: "not-found", candidates, diagnostics };
    }

    if (candidates.length === 1) {
      return {
        kind: "selected",
        source: "auto",
        candidate: candidates[0]!,
        candidates,
        diagnostics,
      };
    }

    return { kind: "multiple", candidates, diagnostics };
  }

  private async detectConfiguredProject(
    configuredProjectPath: string,
    workspaceFolders: readonly string[],
  ): Promise<ProjectDetectionResult> {
    const configuredPathIsAbsolute = isAbsolute(configuredProjectPath);
    const attemptedPaths = configuredPathIsAbsolute
      ? [
          {
            targetPath: resolve(configuredProjectPath),
            workspacePath: this.findOwningWorkspace(configuredProjectPath, workspaceFolders),
          },
        ]
      : workspaceFolders
          .map((workspacePath) => ({
            targetPath: resolve(workspacePath, configuredProjectPath),
            workspacePath,
          }))
          .filter(({ targetPath, workspacePath }) => isPathWithin(targetPath, workspacePath));

    if (attemptedPaths.length === 0) {
      return this.invalidConfiguredPath(
        configuredProjectPath,
        "No workspace folder is available to resolve the configured project path.",
      );
    }

    const candidates: ProjectCandidate[] = [];
    const seenRoots = new Set<string>();

    const uniqueAttempts = new Map<string, string | undefined>();
    for (const attempt of attemptedPaths) {
      uniqueAttempts.set(resolve(attempt.targetPath), attempt.workspacePath);
    }

    for (const [attemptedPath, workspacePath] of uniqueAttempts) {
      const candidate = await this.candidateFromConfiguredPath(attemptedPath, workspacePath);

      if (!candidate) {
        continue;
      }

      const key = await this.canonicalKey(candidate.rootPath);
      if (!configuredPathIsAbsolute && workspacePath) {
        const workspaceKey = await this.canonicalKey(workspacePath);
        if (!isPathWithin(key, workspaceKey)) {
          continue;
        }
      }
      if (!seenRoots.has(key)) {
        seenRoots.add(key);
        candidates.push(candidate);
      }
    }

    this.sortCandidates(candidates, workspaceFolders);

    if (candidates.length === 1) {
      return {
        kind: "selected",
        source: "configured",
        candidate: candidates[0]!,
        candidates,
        diagnostics: [],
      };
    }

    if (candidates.length > 1) {
      return {
        kind: "invalid-configured-path",
        configuredProjectPath,
        candidates,
        diagnostics: [
          {
            code: "ambiguous-configured-path",
            path: configuredProjectPath,
            message:
              "The configured relative project path matches more than one workspace folder. Use an absolute path instead.",
          },
        ],
      };
    }

    return this.invalidConfiguredPath(
      configuredProjectPath,
      `Expected a project directory containing ${PROJECT_CONFIG_FILE}, or that file itself.`,
    );
  }

  private invalidConfiguredPath(
    configuredProjectPath: string,
    message: string,
  ): ProjectDetectionResult {
    return {
      kind: "invalid-configured-path",
      configuredProjectPath,
      candidates: [],
      diagnostics: [
        {
          code: "invalid-configured-path",
          path: configuredProjectPath,
          message,
        },
      ],
    };
  }

  private async discoverCandidates(
    workspaceFolders: readonly string[],
    diagnostics: ProjectDetectorDiagnostic[],
  ): Promise<ProjectCandidate[]> {
    const candidates: ProjectCandidate[] = [];
    const seenRoots = new Set<string>();

    for (const workspacePath of workspaceFolders) {
      const visitedDirectories = new Set<string>();
      await this.walkDirectory(
        workspacePath,
        workspacePath,
        visitedDirectories,
        seenRoots,
        candidates,
        diagnostics,
      );
    }

    this.sortCandidates(candidates, workspaceFolders);
    return candidates;
  }

  private async walkDirectory(
    directoryPath: string,
    workspacePath: string,
    visitedDirectories: Set<string>,
    seenRoots: Set<string>,
    candidates: ProjectCandidate[],
    diagnostics: ProjectDetectorDiagnostic[],
  ): Promise<void> {
    const resolvedDirectoryPath = resolve(directoryPath);
    const directoryKey = await this.canonicalKey(resolvedDirectoryPath);
    const workspaceKey = await this.canonicalKey(workspacePath);

    // A directory symlink can point into a dependency tree or outside the open
    // workspace. Discovery must not escape the workspace through that route.
    if (!isPathWithin(directoryKey, workspaceKey)) {
      return;
    }

    if (visitedDirectories.has(directoryKey)) {
      return;
    }
    visitedDirectories.add(directoryKey);

    let entries: readonly ProjectDirectoryEntry[];
    try {
      entries = await this.fileSystem.readDirectory(resolvedDirectoryPath);
    } catch (error) {
      diagnostics.push({
        code: "unreadable-directory",
        path: resolvedDirectoryPath,
        message: `Unable to inspect directory: ${errorMessage(error)}`,
      });
      return;
    }

    const sortedEntries = [...entries].sort((left, right) => comparePaths(left.name, right.name));

    for (const entry of sortedEntries) {
      if (entry.name === PROJECT_CONFIG_FILE && entry.isFile()) {
        await this.addCandidate(
          resolvedDirectoryPath,
          workspacePath,
          seenRoots,
          candidates,
        );
        continue;
      }

      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink?.() ||
        this.excludedDirectoryNames.has(entry.name)
      ) {
        continue;
      }

      await this.walkDirectory(
        join(resolvedDirectoryPath, entry.name),
        workspacePath,
        visitedDirectories,
        seenRoots,
        candidates,
        diagnostics,
      );
    }
  }

  private async addCandidate(
    rootPath: string,
    workspacePath: string | undefined,
    seenRoots: Set<string>,
    candidates: ProjectCandidate[],
  ): Promise<void> {
    const resolvedRootPath = resolve(rootPath);
    const key = await this.canonicalKey(resolvedRootPath);
    if (seenRoots.has(key)) {
      return;
    }

    seenRoots.add(key);
    candidates.push(this.createCandidate(resolvedRootPath, workspacePath));
  }

  private async candidateFromConfiguredPath(
    targetPath: string,
    workspacePath: string | undefined,
  ): Promise<ProjectCandidate | undefined> {
    const resolvedTargetPath = resolve(targetPath);
    let targetStats: ProjectFileStats;

    try {
      targetStats = await this.fileSystem.stat(resolvedTargetPath);
    } catch {
      return undefined;
    }

    if (targetStats.isFile()) {
      if (basename(resolvedTargetPath) !== PROJECT_CONFIG_FILE) {
        return undefined;
      }

      return this.createCandidate(dirname(resolvedTargetPath), workspacePath);
    }

    if (!targetStats.isDirectory()) {
      return undefined;
    }

    const configPath = join(resolvedTargetPath, PROJECT_CONFIG_FILE);
    try {
      const configStats = await this.fileSystem.stat(configPath);
      if (!configStats.isFile()) {
        return undefined;
      }
    } catch {
      return undefined;
    }

    return this.createCandidate(resolvedTargetPath, workspacePath);
  }

  private createCandidate(rootPath: string, workspacePath: string | undefined): ProjectCandidate {
    const resolvedRootPath = resolve(rootPath);
    const resolvedWorkspacePath = workspacePath ? resolve(workspacePath) : undefined;
    const relativePath = resolvedWorkspacePath
      ? relative(resolvedWorkspacePath, resolvedRootPath) || "."
      : resolvedRootPath;

    return {
      rootPath: resolvedRootPath,
      configPath: join(resolvedRootPath, PROJECT_CONFIG_FILE),
      workspacePath: resolvedWorkspacePath,
      relativePath,
    };
  }

  private findOwningWorkspace(
    targetPath: string,
    workspaceFolders: readonly string[],
  ): string | undefined {
    const resolvedTargetPath = resolve(targetPath);
    return workspaceFolders
      .filter((workspacePath) => isPathWithin(resolvedTargetPath, workspacePath))
      .sort((left, right) => right.length - left.length)[0];
  }

  private sortCandidates(candidates: ProjectCandidate[], workspaceFolders: readonly string[]): void {
    const workspaceOrder = new Map(workspaceFolders.map((folder, index) => [folder, index]));
    candidates.sort((left, right) => {
      const leftIndex = left.workspacePath ? workspaceOrder.get(left.workspacePath) : undefined;
      const rightIndex = right.workspacePath ? workspaceOrder.get(right.workspacePath) : undefined;
      const normalizedLeftIndex = leftIndex ?? Number.MAX_SAFE_INTEGER;
      const normalizedRightIndex = rightIndex ?? Number.MAX_SAFE_INTEGER;

      return (
        normalizedLeftIndex - normalizedRightIndex ||
        comparePaths(left.relativePath, right.relativePath) ||
        comparePaths(left.rootPath, right.rootPath)
      );
    });
  }

  private async canonicalKey(targetPath: string): Promise<string> {
    const resolvedTargetPath = resolve(targetPath);
    if (!this.fileSystem.realpath) {
      return resolvedTargetPath;
    }

    try {
      return resolve(await this.fileSystem.realpath(resolvedTargetPath));
    } catch {
      return resolvedTargetPath;
    }
  }
}

function uniqueResolvedPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const candidatePath of paths) {
    const resolvedPath = resolve(candidatePath);
    if (!seen.has(resolvedPath)) {
      seen.add(resolvedPath);
      result.push(resolvedPath);
    }
  }

  return result;
}

function isPathWithin(candidatePath: string, parentPath: string): boolean {
  const pathFromParent = relative(resolve(parentPath), resolve(candidatePath));
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
