/** Structured errors that can cross the Electron, RPC, and MCP boundaries. */
export type PlatformErrorCode =
  | "UNKNOWN_COMMAND"
  | "NOT_FOUND"
  | "COST_UNKNOWN"
  | "IDEMPOTENCY_CONFLICT"
  | "APP_CLOSED"
  | "NOT_SUPPORTED"
  | "APP_NOT_RUNNING"
  | "NOT_CONNECTED"
  | "PERMISSION_DENIED"
  | "VALIDATION_FAILED"
  | "POLICY_BLOCKED"
  | "VERSION_CONFLICT"
  | "APPROVAL_REQUIRED"
  | "PLAN_EXPIRED"
  | "COST_CHANGED"
  | "STORAGE_FULL"
  | "RESULT_UNKNOWN"
  | "CREDENTIAL_PROTECTION_UNAVAILABLE"
  | "PATH_NOT_ALLOWED"
  | "EXTERNAL_URL_BLOCKED"
  | "CLIENT_UNSUPPORTED"
  | "SETUP_CONFLICT"
  | "REQUEST_TOO_LARGE"
  | "INTERNAL_ERROR";

export class PlatformError extends Error {
  readonly code: PlatformErrorCode;
  readonly params: Record<string, unknown>;
  readonly retryable: boolean;
  readonly action?: string;
  readonly data: { code: PlatformErrorCode; messageKey: string; params: Record<string, unknown>; retryable: boolean; action?: string };

  constructor(
    code: PlatformErrorCode,
    message: string = code,
    options: { params?: Record<string, unknown>; retryable?: boolean; action?: string; cause?: unknown; messageKey?: string } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "PlatformError";
    this.code = code;
    this.params = options.params ?? {};
    this.retryable = options.retryable ?? false;
    this.action = options.action;
    this.data = { code, messageKey: options.messageKey ?? message, params: this.params, retryable: this.retryable, ...(this.action ? { action: this.action } : {}) };
  }
}

export function asPlatformError(error: unknown, fallback: PlatformErrorCode = "INTERNAL_ERROR"): PlatformError {
  if (error instanceof PlatformError) return error;
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: unknown }).data;
    if (data && typeof data === "object" && typeof (data as { code?: unknown }).code === "string") {
      const structured = data as { code: string; messageKey?: string; params?: Record<string, unknown>; retryable?: boolean };
      return new PlatformError(structured.code as PlatformErrorCode, structured.messageKey ?? structured.code, { params: structured.params, retryable: structured.retryable, messageKey: structured.messageKey });
    }
  }
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    const code = error.code as PlatformErrorCode;
    if (code in PLATFORM_ERROR_CODES) return new PlatformError(code, error instanceof Error ? error.message : code, { cause: error });
  }
  return new PlatformError(fallback, error instanceof Error ? error.message : String(error), { cause: error });
}

const PLATFORM_ERROR_CODES: Record<string, true> = {
  UNKNOWN_COMMAND: true,
  NOT_FOUND: true,
  COST_UNKNOWN: true,
  IDEMPOTENCY_CONFLICT: true,
  APP_CLOSED: true,
  NOT_SUPPORTED: true,
  APP_NOT_RUNNING: true,
  NOT_CONNECTED: true,
  PERMISSION_DENIED: true,
  VALIDATION_FAILED: true,
  POLICY_BLOCKED: true,
  VERSION_CONFLICT: true,
  APPROVAL_REQUIRED: true,
  PLAN_EXPIRED: true,
  COST_CHANGED: true,
  STORAGE_FULL: true,
  RESULT_UNKNOWN: true,
  CREDENTIAL_PROTECTION_UNAVAILABLE: true,
  PATH_NOT_ALLOWED: true,
  EXTERNAL_URL_BLOCKED: true,
  CLIENT_UNSUPPORTED: true,
  SETUP_CONFLICT: true,
  REQUEST_TOO_LARGE: true,
  INTERNAL_ERROR: true,
};

export type ErrorPayload = {
  code: string;
  message: string;
  messageKey: string;
  params: Record<string, unknown>;
  retryable: boolean;
  action?: string;
};

export function errorPayload(error: unknown): ErrorPayload {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: unknown }).data;
    if (data && typeof data === "object" && typeof (data as { code?: unknown }).code === "string" && typeof (data as { messageKey?: unknown }).messageKey === "string") {
      const structured = data as { code: string; messageKey: string; params?: Record<string, unknown>; retryable?: boolean; action?: string };
      return {
        code: structured.code,
        message: structured.messageKey,
        messageKey: structured.messageKey,
        params: structured.params ?? {},
        retryable: structured.retryable ?? false,
        ...(structured.action ? { action: structured.action } : {}),
      };
    }
  }
  const normalized = asPlatformError(error);
  return {
    code: normalized.code,
    message: normalized.message,
    messageKey: normalized.message,
    params: normalized.params,
    retryable: normalized.retryable,
    ...(normalized.action ? { action: normalized.action } : {}),
  };
}

/** Plain data that can safely cross Electron's invoke boundary. */
export type IpcErrorEnvelope = ErrorPayload & { __studioError: true };

export function serializeIpcError(error: unknown): IpcErrorEnvelope {
  if (isIpcErrorEnvelope(error)) return error;
  return { __studioError: true, ...errorPayload(error) };
}

export function isIpcErrorEnvelope(value: unknown): value is IpcErrorEnvelope {
  return Boolean(value && typeof value === "object" && (value as { __studioError?: unknown }).__studioError === true && typeof (value as { code?: unknown }).code === "string" && typeof (value as { message?: unknown }).message === "string");
}

export function reviveIpcError(value: unknown): Error {
  if (isIpcErrorEnvelope(value)) {
    return new PlatformError(value.code as PlatformErrorCode, value.message, { messageKey: value.messageKey, params: value.params, retryable: value.retryable, action: value.action });
  }
  return value instanceof Error ? value : asPlatformError(value);
}
