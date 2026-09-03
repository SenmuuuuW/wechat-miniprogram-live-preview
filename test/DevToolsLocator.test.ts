import assert from "node:assert/strict";
import { test } from "node:test";

import { DevToolsLocator } from "../src/devtools/DevToolsLocator";

test("resolves the CLI inside a configured Mac app bundle", async () => {
  const calls: string[] = [];
  const locator = new DevToolsLocator({
    platform: "darwin",
    fileSystem: {
      executable: async (path) => {
        calls.push(path);
        return path.endsWith("/Contents/MacOS/cli");
      },
    },
  });
  const result = await locator.locate("/Applications/Test.app");
  assert.equal(result.cliPath, "/Applications/Test.app/Contents/MacOS/cli");
  assert.equal(result.source, "configured");
  assert.ok(calls.length >= 2);
});

test("uses known location before system discovery", async () => {
  const result = await new DevToolsLocator({
    platform: "darwin",
    fileSystem: {
      executable: async (path) => path === "/Applications/wechatwebdevtools.app/Contents/MacOS/cli",
    },
    commandRunner: {
      findApplicationPaths: async () => ["/other.app"],
    },
  }).locate();
  assert.equal(result.source, "known-location");
});

test("reports an actionable error when no CLI is found", async () => {
  await assert.rejects(
    () => new DevToolsLocator({
      platform: "linux",
      fileSystem: { executable: async () => false },
      commandRunner: { findApplicationPaths: async () => [] },
    }).locate(),
    /Unable to find the WeChat DevTools CLI/,
  );
});
