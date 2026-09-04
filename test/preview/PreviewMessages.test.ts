import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_INPUT_LENGTH,
  MAX_SCROLL_DELTA,
  parsePreviewWebviewMessage,
} from "../../src/preview/PreviewMessages.js";

test("parses the exact zero-payload control messages", () => {
  for (const type of ["ready", "reconnect", "refresh", "back", "exitTyping"] as const) {
    assert.deepEqual(parsePreviewWebviewMessage({ type }), { type });
  }
});

test("parses preview acknowledgement and interaction payloads", () => {
  assert.deepEqual(
    parsePreviewWebviewMessage({ type: "previewRendered", generation: 3 }),
    { type: "previewRendered", generation: 3 },
  );
  assert.deepEqual(
    parsePreviewWebviewMessage({ type: "tap", generation: 7, screenshotX: 12.5, screenshotY: 0 }),
    { type: "tap", generation: 7, screenshotX: 12.5, screenshotY: 0 },
  );
  assert.deepEqual(
    parsePreviewWebviewMessage({
      type: "scroll",
      generation: 9,
      screenshotX: 4,
      screenshotY: 8,
      deltaX: -120,
      deltaY: 240,
    }),
    {
      type: "scroll",
      generation: 9,
      screenshotX: 4,
      screenshotY: 8,
      deltaX: -120,
      deltaY: 240,
    },
  );
  assert.deepEqual(
    parsePreviewWebviewMessage({ type: "input", generation: 2, value: "hello" }),
    { type: "input", generation: 2, value: "hello" },
  );
});

test("rejects unknown message types, primitives, arrays, and extra fields", () => {
  const invalid: unknown[] = [
    undefined,
    null,
    "tap",
    1,
    [],
    { type: "unknown" },
    { type: "ready", extra: true },
    { type: "tap", generation: 1, screenshotX: 0, screenshotY: 0, extra: true },
    { type: "input", generation: 1, value: "ok", accidental: null },
  ];

  for (const value of invalid) {
    assert.equal(parsePreviewWebviewMessage(value), undefined);
  }
});

test("requires positive safe integer generations", () => {
  for (const generation of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(parsePreviewWebviewMessage({ type: "previewRendered", generation }), undefined);
  }
});

test("rejects invalid screenshot coordinates and bounded scroll deltas", () => {
  const invalidCoordinates = [-1, Number.NaN, Number.POSITIVE_INFINITY];
  for (const screenshotX of invalidCoordinates) {
    assert.equal(
      parsePreviewWebviewMessage({ type: "tap", generation: 1, screenshotX, screenshotY: 0 }),
      undefined,
    );
  }

  for (const delta of [Number.NaN, Number.NEGATIVE_INFINITY, MAX_SCROLL_DELTA + 1, -MAX_SCROLL_DELTA - 1]) {
    assert.equal(
      parsePreviewWebviewMessage({
        type: "scroll",
        generation: 1,
        screenshotX: 0,
        screenshotY: 0,
        deltaX: delta,
        deltaY: 0,
      }),
      undefined,
    );
  }
});

test("enforces the input batch length limit", () => {
  assert.deepEqual(
    parsePreviewWebviewMessage({ type: "input", generation: 1, value: "a".repeat(MAX_INPUT_LENGTH) }),
    { type: "input", generation: 1, value: "a".repeat(MAX_INPUT_LENGTH) },
  );
  assert.equal(
    parsePreviewWebviewMessage({ type: "input", generation: 1, value: "a".repeat(MAX_INPUT_LENGTH + 1) }),
    undefined,
  );
});

test("fails closed when a hostile property getter throws", () => {
  const value = {} as { type?: string };
  Object.defineProperty(value, "type", {
    enumerable: true,
    get: () => {
      throw new Error("unexpected getter");
    },
  });

  assert.equal(parsePreviewWebviewMessage(value), undefined);
});
