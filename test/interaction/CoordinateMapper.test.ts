import assert from "node:assert/strict";
import test from "node:test";

import {
  CoordinateMapper,
  type RuntimeCoordinateLayout,
  type StageImageLayout,
} from "../../src/interaction/CoordinateMapper.js";

function layout(overrides: Partial<RuntimeCoordinateLayout> = {}): RuntimeCoordinateLayout {
  return {
    stage: { left: 0, top: 0, width: 400, height: 800 },
    imageBox: { left: 0, top: 0, width: 400, height: 800 },
    screenshotSize: { width: 800, height: 1600 },
    runtimeSize: { width: 400, height: 800 },
    ...overrides,
  };
}

test("maps an exact-ratio stage through screenshot pixels into runtime coordinates", () => {
  const mapped = CoordinateMapper.mapStagePointToRuntime({ x: 200, y: 400 }, layout());

  assert.deepEqual(mapped?.screenshotPoint, { x: 400, y: 800 });
  assert.deepEqual(mapped?.runtimePoint, { x: 200, y: 400 });
  assert.deepEqual(mapped?.normalizedPoint, { x: 0.5, y: 0.5 });
});

test("rejects stage points in horizontal contain letterboxes", () => {
  const stageLayout = layout({
    stage: { left: 0, top: 0, width: 500, height: 700 },
    imageBox: { left: 0, top: 0, width: 500, height: 700 },
    screenshotSize: { width: 780, height: 1506 },
    runtimeSize: { width: 390, height: 753 },
  });
  const content = CoordinateMapper.containedImageRect(stageLayout.imageBox, stageLayout.screenshotSize);

  assert.ok(content);
  assert.ok(Math.abs((content?.width ?? 0) - 362.54980079681276) < 0.000001);
  assert.ok(Math.abs((content?.left ?? 0) - 68.72509960159362) < 0.000001);
  assert.equal(CoordinateMapper.mapStagePointToRuntime({ x: 20, y: 350 }, stageLayout), undefined);
  assert.equal(CoordinateMapper.mapStagePointToRuntime({ x: 480, y: 350 }, stageLayout), undefined);

  const center = CoordinateMapper.mapStagePointToRuntime({ x: 250, y: 350 }, stageLayout);
  assert.deepEqual(center?.screenshotPoint, { x: 390, y: 753 });
  assert.deepEqual(center?.runtimePoint, { x: 195, y: 377 });
});

test("uses the image element offset before applying contain", () => {
  const stageLayout: StageImageLayout = {
    stage: { left: 10, top: 20, width: 500, height: 700 },
    imageBox: { left: 30, top: 70, width: 320, height: 600 },
    screenshotSize: { width: 400, height: 800 },
  };

  const content = CoordinateMapper.containedImageRect(stageLayout.imageBox, stageLayout.screenshotSize);
  assert.deepEqual(content, { left: 40, top: 70, width: 300, height: 600 });

  assert.equal(CoordinateMapper.mapStagePointToScreenshot({ x: 25, y: 200 }, stageLayout), undefined);
  assert.equal(CoordinateMapper.mapStagePointToScreenshot({ x: 35, y: 60 }, stageLayout), undefined);
  assert.deepEqual(
    CoordinateMapper.mapStagePointToScreenshot({ x: 190, y: 370 }, stageLayout)?.screenshotPoint,
    { x: 200, y: 400 },
  );
});

test("clamps edge and out-of-range screenshot coordinates deterministically", () => {
  assert.deepEqual(
    CoordinateMapper.mapScreenshotPointToRuntime(
      { x: -10.2, y: 99.9 },
      { width: 100, height: 50 },
      { width: 10, height: 5 },
    ),
    { x: 0, y: 4 },
  );
  assert.deepEqual(
    CoordinateMapper.mapStagePointToRuntime({ x: 400, y: 800 }, layout())?.runtimePoint,
    { x: 399, y: 799 },
  );
});

test("is invariant when client geometry is uniformly scaled by browser zoom or DPR", () => {
  const baseline = CoordinateMapper.mapStagePointToRuntime({ x: 200, y: 400 }, layout());
  const zoomed = CoordinateMapper.mapStagePointToRuntime(
    { x: 300, y: 600 },
    layout({
      stage: { left: 0, top: 0, width: 600, height: 1200 },
      imageBox: { left: 0, top: 0, width: 600, height: 1200 },
    }),
  );

  assert.deepEqual(zoomed?.screenshotPoint, baseline?.screenshotPoint);
  assert.deepEqual(zoomed?.runtimePoint, baseline?.runtimePoint);
});

test("returns undefined for invalid dimensions and points outside the stage", () => {
  assert.equal(CoordinateMapper.mapStagePointToScreenshot({ x: 0, y: 0 }, {
    stage: { left: 0, top: 0, width: 0, height: 200 },
    imageBox: { left: 0, top: 0, width: 100, height: 200 },
    screenshotSize: { width: 100, height: 200 },
  }), undefined);
  assert.equal(CoordinateMapper.mapStagePointToScreenshot({ x: 5, y: 5 }, {
    stage: { left: 10, top: 10, width: 100, height: 200 },
    imageBox: { left: 0, top: 0, width: 100, height: 200 },
    screenshotSize: { width: 100, height: 200 },
  }), undefined);
});
