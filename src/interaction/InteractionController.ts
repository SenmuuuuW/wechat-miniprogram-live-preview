import { PreviewError } from "../errors/PreviewError";
import { rankElementCandidates } from "./ElementResolver";
import type { InteractionResult, PreviewInteraction, ResolvedElement, RuntimePage } from "./InteractionTypes";

export interface InteractionRuntime {
  currentPage(): Promise<RuntimePage | undefined>;
  navigateBack?(): Promise<unknown>;
  pageScrollTo?(scrollTop: number): Promise<void>;
}

export interface InteractionControllerOptions {
  readonly selectorTimeoutMs?: number;
  /** Test seam for deterministic selector timeout coverage. */
  readonly withTimeout?: <T>(operation: Promise<T>, timeoutMs: number) => Promise<T>;
}

/** Performs real Automator operations without exposing runtime protocol to the UI. */
export class InteractionController {
  private readonly selectorTimeoutMs: number;
  private readonly timeout: <T>(operation: Promise<T>, timeoutMs: number) => Promise<T>;
  private inputTarget: ResolvedElement | undefined;
  private inputPagePath: string | undefined;
  /** Selector discovery wedges in some DevTools releases. Never repeat it on one connection. */
  private selectorDiscoveryUnavailable = false;
  /** page.scrollTop has the same failure mode in the tested DevTools release. */
  private estimatedPageScrollTop = 0;

  public constructor(
    private readonly runtime: InteractionRuntime,
    options: InteractionControllerOptions = {},
  ) {
    this.selectorTimeoutMs = normalizeTimeout(options.selectorTimeoutMs);
    this.timeout = options.withTimeout ?? withTimeout;
  }

  public clearInputTarget(): void {
    this.inputTarget = undefined;
    this.inputPagePath = undefined;
  }

  /** Reset connection-scoped capability observations after an actual reconnect. */
  public resetForReconnect(): void {
    this.clearInputTarget();
    this.selectorDiscoveryUnavailable = false;
    this.estimatedPageScrollTop = 0;
  }

  public async perform(interaction: PreviewInteraction): Promise<InteractionResult> {
    switch (interaction.kind) {
      case "tap":
        return this.tap(interaction.point.x, interaction.point.y);
      case "scroll":
        return this.scroll(interaction.deltaY);
      case "input":
        return this.input(interaction.value);
      case "back":
        return this.back();
    }
  }

  private async tap(x: number, y: number): Promise<InteractionResult> {
    const page = await this.requirePage();
    const candidates = await this.findCandidates(page);
    const target = rankElementCandidates(candidates, { x, y })[0];
    if (!target) {
      throw unsupported("No real runtime element could be resolved at this position.");
    }
    await target.tap();
    const tag = target.tagName.toLowerCase();
    if ((tag === "input" || tag === "textarea") && target.input) {
      this.inputTarget = target;
      this.inputPagePath = page.path;
      return { kind: "tap", typing: true };
    }
    this.clearInputTarget();
    return { kind: "tap", typing: false };
  }

  private async scroll(deltaY: number): Promise<InteractionResult> {
    if (!this.runtime.pageScrollTo) {
      throw unsupported("Page scrolling is not exposed by this Automator runtime.");
    }
    await this.requirePage();
    // Do not probe page.scrollTop() here. It is not required by pageScrollTo,
    // and it has been observed to wedge this Automator transport.
    const next = Math.max(0, Math.round(this.estimatedPageScrollTop + deltaY));
    await this.runtime.pageScrollTo(next);
    this.estimatedPageScrollTop = next;
    this.clearInputTarget();
    return { kind: "scroll", typing: false };
  }

  private async input(value: string): Promise<InteractionResult> {
    const target = this.inputTarget;
    const page = await this.requirePage();
    if (!target || this.inputPagePath !== page.path || !target.input) {
      this.clearInputTarget();
      throw unsupported("Select a real input or textarea in the preview before typing.");
    }
    await target.input(value);
    return { kind: "input", typing: true };
  }

  private async back(): Promise<InteractionResult> {
    if (!this.runtime.navigateBack) {
      throw unsupported("Back navigation is not exposed by this Automator runtime.");
    }
    await this.runtime.navigateBack();
    this.clearInputTarget();
    return { kind: "back", typing: false };
  }

  private async requirePage(): Promise<RuntimePage> {
    const page = await this.runtime.currentPage();
    if (!page) {
      throw new PreviewError("runtime-disconnected", "The WeChat runtime has no active page.");
    }
    return page;
  }

  private async findCandidates(page: RuntimePage): Promise<readonly ResolvedElement[]> {
    if (this.selectorDiscoveryUnavailable) {
      throw unsupported("Element discovery is unavailable for this WeChat DevTools connection.");
    }
    try {
      return await this.timeout(page.$$("*"), this.selectorTimeoutMs);
    } catch (error) {
      if (error instanceof PreviewError) {
        if (error.code === "interaction-unsupported") {
          this.selectorDiscoveryUnavailable = true;
        }
        throw error;
      }
      this.selectorDiscoveryUnavailable = true;
      throw unsupported("Element discovery timed out in WeChat DevTools.");
    }
  }
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("selector timeout")), timeoutMs);
    void operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function unsupported(message: string): PreviewError {
  return new PreviewError("interaction-unsupported", message);
}

function normalizeTimeout(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value) ? 500 : Math.max(50, Math.floor(value));
}
