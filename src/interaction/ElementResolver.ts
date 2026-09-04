import type { ResolvedElement, RuntimePoint, RuntimeRect } from "./InteractionTypes";

/** Sorts candidates so an interactive, small target wins over a large container. */
export function rankElementCandidates(
  candidates: readonly ResolvedElement[],
  point: RuntimePoint,
): readonly ResolvedElement[] {
  return candidates
    .filter((candidate) => contains(candidate.rect, point))
    .slice()
    .sort((left, right) => {
      const leftScore = score(left, point);
      const rightScore = score(right, point);
      return rightScore - leftScore || area(left.rect) - area(right.rect);
    });
}

export function contains(rect: RuntimeRect, point: RuntimePoint): boolean {
  return Number.isFinite(rect.left)
    && Number.isFinite(rect.top)
    && Number.isFinite(rect.width)
    && Number.isFinite(rect.height)
    && rect.width > 0
    && rect.height > 0
    && point.x >= rect.left
    && point.x <= rect.left + rect.width
    && point.y >= rect.top
    && point.y <= rect.top + rect.height;
}

function score(element: ResolvedElement, point: RuntimePoint): number {
  const tag = element.tagName.toLowerCase();
  const interactive = tag === "button" || tag === "navigator" || tag === "input" || tag === "textarea" || tag === "switch" || tag === "slider";
  const distance = distanceFromCenter(element.rect, point);
  return (interactive ? 1_000_000 : 0) - area(element.rect) - distance;
}

function area(rect: RuntimeRect): number {
  return rect.width * rect.height;
}

function distanceFromCenter(rect: RuntimeRect, point: RuntimePoint): number {
  const x = rect.left + rect.width / 2 - point.x;
  const y = rect.top + rect.height / 2 - point.y;
  return Math.hypot(x, y);
}
