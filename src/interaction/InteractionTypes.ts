export interface RuntimePoint {
  readonly x: number;
  readonly y: number;
}

export type Point = RuntimePoint;

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface RuntimeRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export type Rect = RuntimeRect;

export interface PointerSample extends Point {
  readonly timestamp: number;
  readonly pointerId?: number;
}

export interface GestureMetrics {
  readonly start: Point;
  readonly end: Point;
  readonly delta: Point;
  readonly distance: number;
  readonly maxDistance: number;
  readonly pathLength: number;
  readonly durationMs: number;
}

export type SwipeDirection = "up" | "down" | "left" | "right";
export interface TapGesture extends GestureMetrics { readonly kind: "tap"; }
export interface HoldGesture extends GestureMetrics { readonly kind: "hold"; }
export interface DragGesture extends GestureMetrics { readonly kind: "drag"; }
export interface SwipeGesture extends GestureMetrics { readonly kind: "swipe"; readonly direction: SwipeDirection; }
export type PointerGesture = TapGesture | HoldGesture | DragGesture | SwipeGesture;

export interface WheelSample {
  readonly position: Point;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly timestamp: number;
}

export interface WheelGesture {
  readonly kind: "wheel";
  readonly anchor: Point;
  readonly delta: Point;
  readonly dominantAxis: "horizontal" | "vertical";
  readonly eventCount: number;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMs: number;
}

export type InteractionKind = "tap" | "scroll" | "input" | "back";

export interface TapInteraction {
  readonly kind: "tap";
  readonly point: RuntimePoint;
}

export interface ScrollInteraction {
  readonly kind: "scroll";
  readonly point?: RuntimePoint;
  readonly deltaX?: number;
  readonly deltaY: number;
}

export interface InputInteraction {
  readonly kind: "input";
  readonly value: string;
}

export interface BackInteraction {
  readonly kind: "back";
}

export type PreviewInteraction = TapInteraction | ScrollInteraction | InputInteraction | BackInteraction;

export interface InteractionResult {
  readonly kind: InteractionKind;
  readonly typing: boolean;
  readonly message?: string;
}

export interface ResolvedElement {
  readonly tagName: string;
  readonly rect: RuntimeRect;
  readonly tap: () => Promise<void>;
  readonly input?: (value: string) => Promise<void>;
  readonly scrollTo?: (x: number, y: number) => Promise<void>;
  readonly property?: (name: string) => Promise<unknown>;
}

export interface RuntimePage {
  readonly path: string;
  $(selector: string): Promise<ResolvedElement | null>;
  $$(selector: string): Promise<readonly ResolvedElement[]>;
  scrollTop?(): Promise<string | number | readonly string[]>;
}
