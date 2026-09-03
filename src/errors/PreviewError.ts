export type PreviewErrorCode =
  | "devtools-not-found"
  | "project-not-found"
  | "automation-unavailable"
  | "login-required"
  | "runtime-disconnected"
  | "runtime-exception"
  | "screenshot-failed"
  | "invalid-configuration"
  | "unknown";

export class PreviewError extends Error {
  public readonly code: PreviewErrorCode;
  public readonly causeValue: unknown;
  public readonly action: string | undefined;

  public constructor(
    code: PreviewErrorCode,
    message: string,
    options: { cause?: unknown; action?: string } = {},
  ) {
    super(message);
    this.name = "PreviewError";
    this.code = code;
    this.causeValue = options.cause;
    this.action = options.action;
  }

  public static from(error: unknown, fallbackCode: PreviewErrorCode = "unknown"): PreviewError {
    if (error instanceof PreviewError) {
      return error;
    }

    return new PreviewError(fallbackCode, errorMessage(error), { cause: error });
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
