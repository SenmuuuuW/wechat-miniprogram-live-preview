import assert from "node:assert/strict";
import test from "node:test";

import { contains, rankElementCandidates } from "../../src/interaction/ElementResolver.js";
import type { ResolvedElement, RuntimeRect } from "../../src/interaction/InteractionTypes.js";

function element(tagName: string, rect: RuntimeRect): ResolvedElement {
  return {
    tagName,
    rect,
    tap: async () => undefined,
  };
}

test("ranks an interactive child ahead of its larger non-interactive container", () => {
  const parent = element("view", { left: 0, top: 0, width: 320, height: 320 });
  const label = element("text", { left: 24, top: 24, width: 220, height: 80 });
  const button = element("button", { left: 60, top: 60, width: 100, height: 40 });

  const ranked = rankElementCandidates([parent, label, button], { x: 100, y: 80 });

  assert.deepEqual(ranked, [button, label, parent]);
});

test("uses target size to choose between overlapping interactive descendants", () => {
  const outerButton = element("button", { left: 20, top: 20, width: 240, height: 160 });
  const nestedInput = element("input", { left: 80, top: 60, width: 80, height: 32 });

  const ranked = rankElementCandidates([outerButton, nestedInput], { x: 100, y: 75 });

  assert.equal(ranked[0], nestedInput);
  assert.equal(ranked[1], outerButton);
});

test("filters candidates that do not contain the point or have invalid bounds", () => {
  const validButElsewhere = element("button", { left: 100, top: 100, width: 20, height: 20 });
  const zeroWidth = element("button", { left: 0, top: 0, width: 0, height: 20 });
  const nonFinite = element("input", { left: Number.NaN, top: 0, width: 20, height: 20 });

  assert.deepEqual(rankElementCandidates([validButElsewhere, zeroWidth, nonFinite], { x: 10, y: 10 }), []);
  assert.equal(contains({ left: 0, top: 0, width: 20, height: 20 }, { x: 20, y: 20 }), true);
  assert.equal(contains({ left: 0, top: 0, width: 20, height: 20 }, { x: 20.01, y: 20 }), false);
});
