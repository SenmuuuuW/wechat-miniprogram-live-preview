import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SWIPE_MAX_DURATION_MS,
  DEFAULT_SWIPE_MIN_DISTANCE_PX,
  DEFAULT_TAP_MAX_DISTANCE_PX,
  DEFAULT_TAP_MAX_DURATION_MS,
  DEFAULT_WHEEL_IDLE_MS,
  DEFAULT_WHEEL_MIN_MAGNITUDE_PX,
} from "../../src/interaction/GestureController.js";
import { previewWebviewHtml } from "../../src/preview/webviewHtml.js";

test("injects GestureController defaults into the Webview event policy", () => {
  const html = previewWebviewHtml({ cspSource: "vscode-webview-resource:" } as never, "Preview");

  assert.match(html, new RegExp(`const TAP_MAX_DISTANCE_PX = ${DEFAULT_TAP_MAX_DISTANCE_PX};`));
  assert.match(html, new RegExp(`const TAP_MAX_DURATION_MS = ${DEFAULT_TAP_MAX_DURATION_MS};`));
  assert.match(html, new RegExp(`const SWIPE_MIN_DISTANCE_PX = ${DEFAULT_SWIPE_MIN_DISTANCE_PX};`));
  assert.match(html, new RegExp(`const SWIPE_MAX_DURATION_MS = ${DEFAULT_SWIPE_MAX_DURATION_MS};`));
  assert.match(html, new RegExp(`const WHEEL_IDLE_MS = ${DEFAULT_WHEEL_IDLE_MS};`));
  assert.match(html, new RegExp(`const WHEEL_MIN_MAGNITUDE_PX = ${DEFAULT_WHEEL_MIN_MAGNITUDE_PX};`));
  assert.match(html, /maxDistance <= TAP_MAX_DISTANCE_PX/);
  assert.match(html, /duration <= TAP_MAX_DURATION_MS/);
  assert.match(html, /finalDistance >= SWIPE_MIN_DISTANCE_PX && duration <= SWIPE_MAX_DURATION_MS/);
});
