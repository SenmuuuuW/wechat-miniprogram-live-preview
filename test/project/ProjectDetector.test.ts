import assert from "node:assert/strict";
import { basename, dirname, resolve } from "node:path";
import test from "node:test";

import {
  PROJECT_CONFIG_FILE,
  ProjectDetector,
  type ProjectDirectoryEntry,
  type ProjectFileStats,
  type ProjectFileSystem,
} from "../../src/project/ProjectDetector.js";

class MemoryProjectFileSystem implements ProjectFileSystem {
  private readonly directories = new Set<string>();
  private readonly files = new Set<string>();
  private readonly unreadableDirectories = new Set<string>();

  public constructor(...directories: string[]) {
    for (const directoryPath of directories) {
      this.addDirectory(directoryPath);
    }
  }

  public addDirectory(directoryPath: string): void {
    const resolvedPath = resolve(directoryPath);
    const parentPath = dirname(resolvedPath);
    if (parentPath !== resolvedPath) {
      this.addDirectory(parentPath);
    }
    this.directories.add(resolvedPath);
  }

  public addFile(filePath: string): void {
    const resolvedPath = resolve(filePath);
    this.addDirectory(dirname(resolvedPath));
    this.files.add(resolvedPath);
  }

  public makeUnreadable(directoryPath: string): void {
    this.unreadableDirectories.add(resolve(directoryPath));
  }

  public async readDirectory(directoryPath: string): Promise<readonly ProjectDirectoryEntry[]> {
    const resolvedPath = resolve(directoryPath);
    if (this.unreadableDirectories.has(resolvedPath)) {
      throw new Error("permission denied");
    }
    if (!this.directories.has(resolvedPath)) {
      throw new Error("not a directory");
    }

    const entries = new Map<string, "directory" | "file">();
    for (const childPath of this.directories) {
      if (dirname(childPath) === resolvedPath) {
        entries.set(basename(childPath), "directory");
      }
    }
    for (const childPath of this.files) {
      if (dirname(childPath) === resolvedPath) {
        entries.set(basename(childPath), "file");
      }
    }

    return [...entries].map(([name, kind]) => ({
      name,
      isDirectory: () => kind === "directory",
      isFile: () => kind === "file",
    }));
  }

  public async stat(targetPath: string): Promise<ProjectFileStats> {
    const resolvedPath = resolve(targetPath);
    if (this.files.has(resolvedPath)) {
      return { isDirectory: () => false, isFile: () => true };
    }
    if (this.directories.has(resolvedPath)) {
      return { isDirectory: () => true, isFile: () => false };
    }
    throw new Error("not found");
  }
}

function detectorFor(fileSystem: ProjectFileSystem): ProjectDetector {
  return new ProjectDetector({ fileSystem });
}

test("returns not-found without workspace folders", async () => {
  const result = await detectorFor(new MemoryProjectFileSystem()).detect({ workspaceFolders: [] });

  assert.equal(result.kind, "not-found");
  assert.deepEqual(result.candidates, []);
});

test("auto-selects a nested Mini Program project", async () => {
  const fileSystem = new MemoryProjectFileSystem("/workspace");
  fileSystem.addFile("/workspace/apps/miniprogram/project.config.json");

  const result = await detectorFor(fileSystem).detect({ workspaceFolders: ["/workspace"] });

  assert.equal(result.kind, "selected");
  if (result.kind !== "selected") {
    return;
  }
  assert.equal(result.source, "auto");
  assert.equal(result.candidate.rootPath, "/workspace/apps/miniprogram");
  assert.equal(result.candidate.relativePath, "apps/miniprogram");
  assert.equal(result.candidate.configPath, "/workspace/apps/miniprogram/project.config.json");
});

test("returns deterministically ordered candidates and excludes generated directories", async () => {
  const fileSystem = new MemoryProjectFileSystem("/workspace");
  fileSystem.addFile("/workspace/z-app/project.config.json");
  fileSystem.addFile("/workspace/apps/miniprogram/project.config.json");
  fileSystem.addFile("/workspace/node_modules/example/project.config.json");
  fileSystem.addFile("/workspace/dist/demo/project.config.json");
  fileSystem.addFile("/workspace/miniprogram_npm/vendor/project.config.json");
  fileSystem.addDirectory("/workspace/directory/project.config.json");

  const result = await detectorFor(fileSystem).detect({ workspaceFolders: ["/workspace"] });

  assert.equal(result.kind, "multiple");
  if (result.kind !== "multiple") {
    return;
  }
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.relativePath),
    ["apps/miniprogram", "z-app"],
  );
});

test("uses a valid configured path before automatic discovery", async () => {
  const fileSystem = new MemoryProjectFileSystem("/workspace");
  fileSystem.addFile("/workspace/apps/chosen/project.config.json");
  fileSystem.addFile("/workspace/apps/other/project.config.json");

  const result = await detectorFor(fileSystem).detect({
    workspaceFolders: ["/workspace"],
    configuredProjectPath: "apps/chosen/project.config.json",
  });

  assert.equal(result.kind, "selected");
  if (result.kind !== "selected") {
    return;
  }
  assert.equal(result.source, "configured");
  assert.equal(result.candidate.rootPath, "/workspace/apps/chosen");
});

test("does not silently fall back when an explicit configured path is invalid", async () => {
  const fileSystem = new MemoryProjectFileSystem("/workspace");
  fileSystem.addFile("/workspace/actual/project.config.json");

  const result = await detectorFor(fileSystem).detect({
    workspaceFolders: ["/workspace"],
    configuredProjectPath: "does-not-exist",
  });

  assert.equal(result.kind, "invalid-configured-path");
  assert.equal(result.candidates.length, 0);
  assert.equal(result.diagnostics[0]?.code, "invalid-configured-path");
});

test("rejects a relative configured path that escapes its workspace", async () => {
  const fileSystem = new MemoryProjectFileSystem("/workspace", "/outside");
  fileSystem.addFile("/outside/project.config.json");

  const result = await detectorFor(fileSystem).detect({
    workspaceFolders: ["/workspace"],
    configuredProjectPath: "../outside",
  });

  assert.equal(result.kind, "invalid-configured-path");
});

test("reports an ambiguous configured relative path across workspace folders", async () => {
  const fileSystem = new MemoryProjectFileSystem("/workspace-a", "/workspace-b");
  fileSystem.addFile("/workspace-a/apps/miniprogram/project.config.json");
  fileSystem.addFile("/workspace-b/apps/miniprogram/project.config.json");

  const result = await detectorFor(fileSystem).detect({
    workspaceFolders: ["/workspace-a", "/workspace-b"],
    configuredProjectPath: "apps/miniprogram",
  });

  assert.equal(result.kind, "invalid-configured-path");
  assert.equal(result.diagnostics[0]?.code, "ambiguous-configured-path");
  assert.equal(result.candidates.length, 2);
});

test("keeps discovery diagnosable when a directory cannot be inspected", async () => {
  const fileSystem = new MemoryProjectFileSystem("/workspace");
  fileSystem.addDirectory("/workspace/inaccessible");
  fileSystem.makeUnreadable("/workspace/inaccessible");
  fileSystem.addFile(`/workspace/visible/${PROJECT_CONFIG_FILE}`);

  const result = await detectorFor(fileSystem).detect({ workspaceFolders: ["/workspace"] });

  assert.equal(result.kind, "selected");
  assert.equal(result.diagnostics[0]?.code, "unreadable-directory");
});
