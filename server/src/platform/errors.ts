/**
 * Error taxonomy.
 *
 * Every failure that leaves the API is an AppError with a stable machine `code`, an HTTP status and a human `title`.
 * Anything else is an unexpected defect: logged with its stack, returned to clients as an opaque 500 + requestId.
 */
export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'EMAIL_NOT_VERIFIED'
  | 'MFA_REQUIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PRECONDITION_FAILED'
  | 'UNPROCESSABLE'
  | 'RATE_LIMITED'
  | 'ACCOUNT_LOCKED'
  | 'PAYLOAD_TOO_LARGE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'ENTITLEMENT_EXCEEDED'
  | 'INVALID_TRANSITION'
  | 'SLOT_UNAVAILABLE'
  | 'SERVICE_BUSY'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'INTERNAL';

export interface FieldIssue {
  path: string;
  message: string;
  code?: string;
}

export interface AppErrorOptions {
  detail?: string;
  errors?: FieldIssue[];
  headers?: Record<string, string>;
  cause?: unknown;
  /** Extra machine-readable members merged into the problem document (never secrets). */
  extensions?: Record<string, unknown>;
}

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly title: string;
  readonly detail?: string;
  readonly errors?: FieldIssue[];
  readonly headers?: Record<string, string>;
  readonly extensions?: Record<string, unknown>;

  constructor(status: number, code: ErrorCode, title: string, opts: AppErrorOptions = {}) {
    super(opts.detail ?? title, { cause: opts.cause });
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.title = title;
    this.detail = opts.detail;
    this.errors = opts.errors;
    this.headers = opts.headers;
    this.extensions = opts.extensions;
  }
}

export const Errors = {
  badRequest: (detail: string, o: AppErrorOptions = {}) =>
    new AppError(400, 'BAD_REQUEST', 'Bad request', { ...o, detail }),
  validation: (errors: FieldIssue[], detail = 'One or more fields are invalid') =>
    new AppError(400, 'VALIDATION_FAILED', 'Validation failed', { detail, errors }),
  unauthenticated: (detail = 'Authentication is required') =>
    new AppError(401, 'UNAUTHENTICATED', 'Authentication required', { detail }),
  emailNotVerified: () =>
    new AppError(403, 'EMAIL_NOT_VERIFIED', 'Email verification required', {
      detail: 'Verify your email address before accessing the workspace',
    }),
  forbidden: (detail = 'You do not have permission to perform this action') =>
    new AppError(403, 'FORBIDDEN', 'Forbidden', { detail }),
  /** Deliberately identical for "missing" and "belongs to another tenant" so existence never leaks. */
  notFound: (what = 'Resource') => new AppError(404, 'NOT_FOUND', 'Not found', { detail: `${what} not found` }),
  conflict: (detail: string, o: AppErrorOptions = {}) => new AppError(409, 'CONFLICT', 'Conflict', { ...o, detail }),
  preconditionFailed: (detail = 'The record was changed by someone else; reload and try again') =>
    new AppError(412, 'PRECONDITION_FAILED', 'Precondition failed', { detail }),
  unprocessable: (detail: string, o: AppErrorOptions = {}) =>
    new AppError(422, 'UNPROCESSABLE', 'Unprocessable', { ...o, detail }),
  invalidTransition: (detail: string) => new AppError(409, 'INVALID_TRANSITION', 'Invalid transition', { detail }),
  slotUnavailable: (detail: string) => new AppError(409, 'SLOT_UNAVAILABLE', 'Slot unavailable', { detail }),
  rateLimited: (retryAfterSeconds: number, detail = 'Too many requests') =>
    new AppError(429, 'RATE_LIMITED', 'Too many requests', {
      detail,
      headers: { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))) },
    }),
  payloadTooLarge: (detail = 'Request body too large') =>
    new AppError(413, 'PAYLOAD_TOO_LARGE', 'Payload too large', { detail }),
  idempotencyConflict: (detail = 'Idempotency-Key was reused with a different request') =>
    new AppError(422, 'IDEMPOTENCY_CONFLICT', 'Idempotency key reuse', { detail }),
  busy: (detail = 'The service is temporarily overloaded; retry shortly') =>
    new AppError(503, 'SERVICE_BUSY', 'Service busy', { detail, headers: { 'Retry-After': '2' } }),
  dependencyUnavailable: (detail: string) =>
    new AppError(503, 'DEPENDENCY_UNAVAILABLE', 'Dependency unavailable', { detail, headers: { 'Retry-After': '5' } }),
  internal: () => new AppError(500, 'INTERNAL', 'Internal server error', { detail: 'An unexpected error occurred' }),
};

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

// ---------------------------------------------------------------------------------------------------------------
// PostgreSQL → AppError mapping
// ---------------------------------------------------------------------------------------------------------------
interface PgLike {
  code?: string;
  message?: string;
  constraint?: string;
  detail?: string;
  table?: string;
}

/** Prefixes raised by our SQL functions: `RAISE EXCEPTION 'CODE: human message'`. */
const SQL_RAISE_CODES: Record<string, (msg: string) => AppError> = {
  ILLEGAL_TRANSITION: (m) => Errors.invalidTransition(m),
  INVALID_TRANSITION: (m) => Errors.invalidTransition(m),
  INVALID_STAGE: (m) => Errors.unprocessable(m),
  NOT_FOUND: (m) => Errors.notFound(m.replace(/ not found.*$/i, '') || 'Resource'),
  SLOT_OCCUPIED: (m) => Errors.slotUnavailable(m),
  AGENT_UNAVAILABLE: (m) => Errors.slotUnavailable(m),
  PROPERTY_UNAVAILABLE: (m) => Errors.unprocessable(m),
  UNAUTHORIZED: () => Errors.forbidden(),
  FORBIDDEN: (m) => Errors.forbidden(m),
  INVALID_ARGUMENT: (m) => Errors.badRequest(m),
};

/**
 * Convert any thrown value into an AppError. Returns undefined for genuinely unexpected errors so the caller
 * logs them as defects (with stack) and answers with an opaque 500.
 */
export function fromUnknown(err: unknown): AppError | undefined {
  if (isAppError(err)) return err;
  const e = err as PgLike & { type?: string; status?: number; statusCode?: number };
  if (!e || typeof e !== 'object') return undefined;

  // body-parser / http-errors
  if (e.type === 'entity.too.large') return Errors.payloadTooLarge();
  if (e.type === 'entity.parse.failed') return Errors.badRequest('Malformed JSON body');

  // Connection pool saturation → shed load instead of hanging
  if (typeof e.message === 'string' && /timeout exceeded when trying to connect|too many clients/i.test(e.message)) {
    return Errors.busy();
  }

  switch (e.code) {
    case '23505':
      return Errors.conflict('A record with the same unique value already exists', {
        extensions: e.constraint ? { constraint: e.constraint } : undefined,
      });
    case '23503':
      return Errors.conflict('The operation conflicts with related records', {
        extensions: e.constraint ? { constraint: e.constraint } : undefined,
      });
    case '23502':
      return Errors.unprocessable('A required value is missing');
    case '23514':
      return Errors.unprocessable('A value violates a data rule', {
        extensions: e.constraint ? { constraint: e.constraint } : undefined,
      });
    case '22P02': // invalid_text_representation (bad uuid/enum literal)
    case '22007':
    case '22008':
    case '22003':
      return Errors.badRequest('A value has an invalid format');
    case '42501': // insufficient_privilege — includes "violates row-level security policy"
      return Errors.forbidden();
    case '40001': // serialization_failure
    case '40P01': // deadlock_detected
      return Errors.conflict('The request conflicted with a concurrent change; please retry', {
        headers: { 'Retry-After': '1' },
      });
    case '55P03': // lock_not_available
      return Errors.busy('The resource is locked by another operation; retry shortly');
    case '57014': // query_canceled (statement_timeout)
      return Errors.dependencyUnavailable('The request took too long to complete');
    case '53300': // too_many_connections
    case '53400':
      return Errors.busy();
    case 'P0001': {
      // RAISE EXCEPTION from our SQL functions
      const m = /^([A-Z_]+):\s*(.*)$/s.exec(e.message ?? '');
      if (m && SQL_RAISE_CODES[m[1]]) return SQL_RAISE_CODES[m[1]](m[2]);
      return undefined;
    }
    default:
      return undefined;
  }
}

export interface ProblemDocument {
  type: string;
  title: string;
  status: number;
  detail?: string;
  code: ErrorCode;
  requestId?: string;
  errors?: FieldIssue[];
  /** Deprecated alias of `detail` kept for the legacy front end while it is being rebuilt. */
  error?: string;
  [extension: string]: unknown;
}

export function toProblem(err: AppError, requestId?: string): ProblemDocument {
  return {
    type: `https://docs.anibros.app/errors/${err.code.toLowerCase().replace(/_/g, '-')}`,
    title: err.title,
    status: err.status,
    detail: err.detail,
    code: err.code,
    requestId,
    ...(err.errors ? { errors: err.errors } : {}),
    ...(err.extensions ?? {}),
    error: err.detail ?? err.title,
  };
}
