import type { Point, Rect, Size } from "./InteractionTypes";

/**
 * Geometry reported by a preview webview. Every point and rectangle must be in
 * the same CSS-pixel coordinate space, usually client coordinates.
 */
export interface StageImageLayout {
  /** The visible preview stage. Points outside this rectangle are rejected. */
  readonly stage: Rect;
  /**
   * The image element's content box before `object-fit: contain` is applied.
   * It may equal `stage`, or be a smaller, offset element inside the stage.
   */
  readonly imageBox: Rect;
  /** Natural screenshot pixels returned by the real simulator. */
  readonly screenshotSize: Size;
}

export interface RuntimeCoordinateLayout extends StageImageLayout {
  /** Logical WeChat runtime dimensions, for example systemInfo.windowWidth. */
  readonly runtimeSize: Size;
}

export interface ScreenshotPointMapping {
  readonly stagePoint: Point;
  /** Normalized position within the non-letterboxed image content, in [0, 1]. */
  readonly normalizedPoint: Point;
  /** Integer screenshot-pixel coordinate, clamped to its valid pixel range. */
  readonly screenshotPoint: Point;
  /** The actual visible image content after applying `object-fit: contain`. */
  readonly imageContentRect: Rect;
}

export interface RuntimePointMapping extends ScreenshotPointMapping {
  /** Integer logical-runtime coordinate, clamped to its valid pixel range. */
  readonly runtimePoint: Point;
}

/**
 * Maps a webview pointer to screenshot and logical-runtime coordinates.
 *
 * Browser client coordinates and DOMRect values are both CSS pixels. Device
 * pixel ratio and webview zoom therefore cancel as long as callers do not mix
 * in screen/physical-pixel measurements. The only explicit scaling here is
 * from the displayed image to the screenshot and then to the runtime.
 */
export class CoordinateMapper {
  /** Returns the visible content rect for an `object-fit: contain` image. */
  public static containedImageRect(imageBox: Rect, screenshotSize: Size): Rect | undefined {
    if (!isValidRect(imageBox) || !isValidPixelSize(screenshotSize)) {
      return undefined;
    }

    const scale = Math.min(
      imageBox.width / screenshotSize.width,
      imageBox.height / screenshotSize.height,
    );
    if (!Number.isFinite(scale) || scale <= 0) {
      return undefined;
    }

    const width = screenshotSize.width * scale;
    const height = screenshotSize.height * scale;
    return {
      left: imageBox.left + (imageBox.width - width) / 2,
      top: imageBox.top + (imageBox.height - height) / 2,
      width,
      height,
    };
  }

  /** Maps a stage point into an integer screenshot pixel, or rejects its black bars. */
  public static mapStagePointToScreenshot(
    point: Point,
    layout: StageImageLayout,
  ): ScreenshotPointMapping | undefined {
    if (!isValidPoint(point) || !isValidRect(layout.stage) || !isValidRect(layout.imageBox)) {
      return undefined;
    }
    if (!contains(layout.stage, point)) {
      return undefined;
    }

    const imageContentRect = CoordinateMapper.containedImageRect(layout.imageBox, layout.screenshotSize);
    if (!imageContentRect || !contains(imageContentRect, point)) {
      return undefined;
    }

    const normalizedPoint = {
      x: clamp((point.x - imageContentRect.left) / imageContentRect.width, 0, 1),
      y: clamp((point.y - imageContentRect.top) / imageContentRect.height, 0, 1),
    };

    return {
      stagePoint: { x: point.x, y: point.y },
      normalizedPoint,
      screenshotPoint: {
        x: normalizedToPixel(normalizedPoint.x, layout.screenshotSize.width),
        y: normalizedToPixel(normalizedPoint.y, layout.screenshotSize.height),
      },
      imageContentRect,
    };
  }

  /**
   * Maps a screenshot point to an integer runtime coordinate. Screenshot
   * coordinates are pixel coordinates, while the runtime dimensions describe
   * the full logical width/height; scaling by the dimensions preserves the
   * observed 780x1506 -> 390x753 ratio at the midpoint. The final coordinate
   * is clamped to the last addressable runtime pixel.
   */
  public static mapScreenshotPointToRuntime(
    screenshotPoint: Point,
    screenshotSize: Size,
    runtimeSize: Size,
  ): Point | undefined {
    if (!isValidPoint(screenshotPoint) || !isValidPixelSize(screenshotSize) || !isValidPixelSize(runtimeSize)) {
      return undefined;
    }

    const sourceX = clampPixel(Math.round(screenshotPoint.x), screenshotSize.width);
    const sourceY = clampPixel(Math.round(screenshotPoint.y), screenshotSize.height);
    return {
      x: scaledPixel(sourceX, screenshotSize.width, runtimeSize.width),
      y: scaledPixel(sourceY, screenshotSize.height, runtimeSize.height),
    };
  }

  /** Maps a stage point through the screenshot into logical runtime coordinates. */
  public static mapStagePointToRuntime(
    point: Point,
    layout: RuntimeCoordinateLayout,
  ): RuntimePointMapping | undefined {
    const screenshotMapping = CoordinateMapper.mapStagePointToScreenshot(point, layout);
    if (!screenshotMapping) {
      return undefined;
    }

    const runtimePoint = CoordinateMapper.mapScreenshotPointToRuntime(
      screenshotMapping.screenshotPoint,
      layout.screenshotSize,
      layout.runtimeSize,
    );
    if (!runtimePoint) {
      return undefined;
    }

    return { ...screenshotMapping, runtimePoint };
  }
}

function isValidPoint(point: Point): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function isValidRect(rect: Rect): boolean {
  return Number.isFinite(rect.left)
    && Number.isFinite(rect.top)
    && Number.isFinite(rect.width)
    && Number.isFinite(rect.height)
    && rect.width > 0
    && rect.height > 0;
}

function isValidPixelSize(size: Size): boolean {
  return Number.isFinite(size.width)
    && Number.isFinite(size.height)
    && size.width > 0
    && size.height > 0;
}

function contains(rect: Rect, point: Point): boolean {
  return point.x >= rect.left
    && point.x <= rect.left + rect.width
    && point.y >= rect.top
    && point.y <= rect.top + rect.height;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizedToPixel(normalized: number, dimension: number): number {
  const roundedDimension = Math.max(1, Math.round(dimension));
  const maximum = roundedDimension - 1;
  return maximum === 0 ? 0 : Math.round(clamp(normalized, 0, 1) * maximum);
}

function clampPixel(pixel: number, dimension: number): number {
  return clamp(pixel, 0, Math.max(1, Math.round(dimension)) - 1);
}

function scaledPixel(sourcePixel: number, sourceDimension: number, targetDimension: number): number {
  const target = Math.max(1, Math.round(targetDimension));
  const scaled = Math.round((sourcePixel * target) / Math.max(1, sourceDimension));
  return clamp(scaled, 0, target - 1);
}
