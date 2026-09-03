import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ProjectDetector,
  type ProjectDirectoryEntry,
  type ProjectFileSystem,
} from "../src/project/ProjectDetector";

class MemoryFileSystem implements ProjectFileSystem {
  private readonly directories = new Map<string, ProjectDirectoryEntry[]>();
  private readonly files = new Set<string>();

  public directory(path: string, entries: readonly [string, "directory" | "file"][]): void {
    this.directories.set(path, entries.map(([name, kind]) => ({
      name,
      isDirectory: () => kind === "directory",
      isFile: () => kind === "file",
    })));
  }

  public file(path: string): void {
    this.files.add(path);
  }

  public async readDirectory(path: string): Promise<readonly ProjectDirectoryEntry[]> {
    const entries = this.directories.get(path);
    if (!entries) {
      throw new Error(`missing directory ${path}`);
    }
    return entries;
  }

  public async stat(path: string) {
    if (this.files.has(path)) {
      return { isFile: () => true, isDirectory: () => false };
    }
    if (this.directories.has(path)) {
      return { isFile: () => false, isDirectory: () => true };
    }
    throw new Error(`missing path ${path}`);
  }
}

test("selects a root project.config.json automatically", async () => {
  const fs = new MemoryFileSystem();
  fs.directory("/workspace", [["project.config.json", "file"], ["src", "directory"]]);
  fs.directory("/workspace/src", []);
  fs.file("/workspace/project.config.json");

  const result = await new ProjectDetector({ fileSystem: fs }).detect({ workspaceFolders: ["/workspace"] });
  assert.equal(result.kind, "selected");
  if (result.kind === "selected") {
    assert.equal(result.candidate.rootPath, "/workspace");
    assert.equal(result.source, "auto");
  }
});

test("finds nested monorepo projects and excludes generated directories", async () => {
  const fs = new MemoryFileSystem();
  fs.directory("/repo", [["apps", "directory"], ["node_modules", "directory"]]);
  fs.directory("/repo/apps", [["mini", "directory"]]);
  fs.directory("/repo/apps/mini", [["project.config.json", "file"]]);
  fs.directory("/repo/node_modules", [["fake", "directory"]]);
  fs.directory("/repo/node_modules/fake", [["project.config.json", "file"]]);
  fs.file("/repo/apps/mini/project.config.json");
  fs.file("/repo/node_modules/fake/project.config.json");

  const result = await new ProjectDetector({ fileSystem: fs }).detect({ workspaceFolders: ["/repo"] });
  assert.equal(result.kind, "selected");
  if (result.kind === "selected") {
    assert.equal(result.candidate.relativePath, "apps/mini");
  }
});

test("invalid configured path does not silently fall back", async () => {
  const fs = new MemoryFileSystem();
  fs.directory("/workspace", [["project.config.json", "file"]]);
  fs.file("/workspace/project.config.json");

  const result = await new ProjectDetector({ fileSystem: fs }).detect({
    workspaceFolders: ["/workspace"],
    configuredProjectPath: "missing",
  });
  assert.equal(result.kind, "invalid-configured-path");
});

test("returns multiple candidates in deterministic order", async () => {
  const fs = new MemoryFileSystem();
  fs.directory("/workspace", [["z", "directory"], ["a", "directory"]]);
  fs.directory("/workspace/z", [["project.config.json", "file"]]);
  fs.directory("/workspace/a", [["project.config.json", "file"]]);
  fs.file("/workspace/z/project.config.json");
  fs.file("/workspace/a/project.config.json");

  const result = await new ProjectDetector({ fileSystem: fs }).detect({ workspaceFolders: ["/workspace"] });
  assert.equal(result.kind, "multiple");
  if (result.kind === "multiple") {
    assert.deepEqual(result.candidates.map((candidate) => candidate.relativePath), ["a", "z"]);
  }
});
