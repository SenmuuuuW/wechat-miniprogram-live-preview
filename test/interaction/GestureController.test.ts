import assert from "node:assert/strict";
import test from "node:test";

import {
  GestureController,
  WheelGestureAggregator,
} from "../../src/interaction/GestureController.js";

test("classifies small jitter as a tap", () => {
  const gestures = new GestureController();
  gestures.begin({ x: 100, y: 100, timestamp: 10, pointerId: 1 });
  gestures.move({ x: 104, y: 103, timestamp: 30, pointerId: 1 });
  const result = gestures.end({ x: 106, y: 105, timestamp: 80, pointerId: 1 });

  assert.equal(result?.kind, "tap");
  assert.equal(result?.durationMs, 70);
  assert.ok((result?.maxDistance ?? 0) > 7);
});

test("does not convert a tiny drag or a long stationary pointer into a tap", () => {
  const gestures = new GestureController();
  gestures.begin({ x: 0, y: 0, timestamp: 0 });
  assert.equal(gestures.end({ x: 10, y: 0, timestamp: 100 })?.kind, "drag");

  gestures.begin({ x: 0, y: 0, timestamp: 0 });
  assert.equal(gestures.end({ x: 0, y: 0, timestamp: 451 })?.kind, "hold");
});

test("classifies all cardinal swipes using their final displacement", () => {
  const cases = [
    [{ x: 100, y: 0 }, "right"],
    [{ x: -100, y: 0 }, "left"],
    [{ x: 0, y: 100 }, "down"],
    [{ x: 0, y: -100 }, "up"],
  ] as const;

  for (const [end, direction] of cases) {
    const gestures = new GestureController();
    gestures.begin({ x: 0, y: 0, timestamp: 0 });
    const result = gestures.end({ ...end, timestamp: 200 });
    assert.equal(result?.kind, "swipe");
    if (result?.kind === "swipe") {
      assert.equal(result.direction, direction);
    }
  }
});

test("uses intermediate motion to prevent a return-to-origin drag from becoming a tap", () => {
  const gestures = new GestureController();
  gestures.begin({ x: 0, y: 0, timestamp: 0 });
  gestures.move({ x: 40, y: 0, timestamp: 20 });
  const result = gestures.end({ x: 0, y: 0, timestamp: 40 });

  assert.equal(result?.kind, "drag");
  assert.equal(result?.maxDistance, 40);
  assert.equal(result?.pathLength, 80);
});

test("keeps different pointer IDs from terminating the active gesture", () => {
  const gestures = new GestureController();
  gestures.begin({ x: 0, y: 0, timestamp: 0, pointerId: 1 });
  assert.equal(gestures.end({ x: 100, y: 0, timestamp: 10, pointerId: 2 }), undefined);
  assert.equal(gestures.isTracking, true);
  assert.equal(gestures.end({ x: 0, y: 0, timestamp: 20, pointerId: 1 })?.kind, "tap");
});

test("coalesces a wheel burst into one meaningful scroll gesture", () => {
  const wheel = new WheelGestureAggregator({ idleMs: 80 });
  assert.equal(wheel.push({ position: { x: 50, y: 60 }, deltaX: 0, deltaY: 2, timestamp: 0 }), undefined);
  assert.equal(wheel.push({ position: { x: 51, y: 61 }, deltaX: 0, deltaY: 7, timestamp: 20 }), undefined);
  assert.equal(wheel.push({ position: { x: 52, y: 62 }, deltaX: 1, deltaY: 12, timestamp: 60 }), undefined);
  assert.equal(wheel.dueAt, 140);
  assert.equal(wheel.flushIfDue(139), undefined);

  const result = wheel.flushIfDue(140);
  assert.deepEqual(result, {
    kind: "wheel",
    anchor: { x: 52, y: 62 },
    delta: { x: 1, y: 21 },
    dominantAxis: "vertical",
    eventCount: 3,
    startedAt: 0,
    endedAt: 60,
    durationMs: 60,
  });
  assert.equal(wheel.hasPending, false);
});

test("flushes an idle wheel batch when a later sample arrives and starts a new one", () => {
  const wheel = new WheelGestureAggregator({ idleMs: 50 });
  wheel.push({ position: { x: 0, y: 0 }, deltaX: 5, deltaY: 0, timestamp: 0 });
  const first = wheel.push({ position: { x: 10, y: 0 }, deltaX: 0, deltaY: -9, timestamp: 70 });

  assert.deepEqual(first?.delta, { x: 5, y: 0 });
  assert.equal(first?.dominantAxis, "horizontal");
  assert.deepEqual(wheel.flush(), {
    kind: "wheel",
    anchor: { x: 10, y: 0 },
    delta: { x: 0, y: -9 },
    dominantAxis: "vertical",
    eventCount: 1,
    startedAt: 70,
    endedAt: 70,
    durationMs: 0,
  });
});

test("drops canceled wheel noise rather than scheduling a no-op runtime scroll", () => {
  const wheel = new WheelGestureAggregator({ minimumMagnitudePx: 2 });
  wheel.push({ position: { x: 0, y: 0 }, deltaX: 1, deltaY: 0, timestamp: 0 });
  wheel.push({ position: { x: 0, y: 0 }, deltaX: -1, deltaY: 0, timestamp: 10 });

  assert.equal(wheel.flush(), undefined);
  assert.equal(wheel.hasPending, false);
});
