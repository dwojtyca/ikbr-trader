import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

// -----------------------------------------------------------------------
// Execution Security (Phase 1 / PR2) — Bearer auth, correlation ID,
// audit log, and process-local burst detector for failed auth attempts.
//
// Design notes (see docs/adr/ADR-001-execution-security.md §PR2):
//  - Bearer compare is constant-time via `crypto.timingSafeEqual`, with
//    both buffers padded to a common length so shorter tokens do NOT leak
//    the expected length via a size mismatch short-circuit.
//  - The token value is never logged. Only `sha256(token).slice(0, 12)`
//    hex is emitted as `tokenFingerprint` for correlation across logs.
//  - Empty `EXECUTION_API_TOKEN` at startup is treated as "no client can
//    ever succeed": every `/execution/*` request is denied (no soft mode).
//    A single startup warning is emitted so operators notice.
//  - `X-Correlation-ID` is accepted only if it matches an RFC 4122 UUID;
//    otherwise a fresh v4 is generated. This prevents log injection while
//    still allowing cross-service tracing when the caller supplies one.
//  - Audit is written once per request in `onResponse` (fire-and-forget)
//    so no request path is ever blocked by a slow/failing audit insert.
// -----------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const BURST_WINDOW_MS = 60_000;
const BURST_THRESHOLD = 3;

export type ExecutionAuditOutcome =
  | "ALLOW"
  | "DENY_AUTH"
  | "DENY_GUARD"
  | "ERROR";

export type ExecutionAuditActorKind = "authenticated" | "unauthenticated";

export interface ExecutionAuditRecord {
  correlationId: string;
  route: string;
  method: string;
  actorKind: ExecutionAuditActorKind;
  tokenFingerprint: string | null;
  ip: string | null;
  requestHash: string | null;
  outcome: ExecutionAuditOutcome;
  reason: string | null;
}

export type ExecutionAuditWriter = (
  record: ExecutionAuditRecord,
) => void | Promise<void>;

export interface AuthFailureBurstAlert {
  ip: string | null;
  count: number;
  windowMs: number;
}

export type AuthFailureBurstEmitter = (
  alert: AuthFailureBurstAlert,
) => void | Promise<void>;

/**
 * Returns the first 12 hex characters of sha256(token). Used as a stable,
 * non-reversible identifier for the active Bearer value so we can correlate
 * requests without ever writing the token itself.
 */
export function fingerprintToken(token: string): string {
  if (!token) return "";
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 12);
}

/**
 * Hash a request's fingerprint (URL + method + body). Used purely as a
 * correlation aid in the audit log. Not a signature.
 */
export function hashRequest(input: {
  url: string;
  method: string;
  body: unknown;
}): string {
  const bodyStr =
    input.body === undefined || input.body === null
      ? ""
      : typeof input.body === "string"
        ? input.body
        : JSON.stringify(input.body);
  return createHash("sha256")
    .update(`${input.method}\n${input.url}\n${bodyStr}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

export type BearerVerifyResult =
  | { ok: true; tokenFingerprint: string }
  | { ok: false; reason: "missing_header" | "malformed" | "wrong_token" };

/**
 * Verifies a Bearer token in constant time. The comparison pads both
 * buffers to `max(len(provided), len(expected), 32)` so no branch depends
 * on the provided token's length. Returns a discriminated union so the
 * caller can decide how to report the reason (but never leaks it to the
 * client — every failure surfaces as HTTP 401 with a generic body).
 */
export function verifyBearerToken(
  authorizationHeader: string | string[] | undefined,
  expectedToken: string,
): BearerVerifyResult {
  const header =
    typeof authorizationHeader === "string"
      ? authorizationHeader
      : Array.isArray(authorizationHeader)
        ? authorizationHeader[0]
        : undefined;

  if (!header) return { ok: false, reason: "missing_header" };

  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return { ok: false, reason: "malformed" };
  const provided = match[1].trim();
  if (!provided) return { ok: false, reason: "malformed" };
  if (!expectedToken) return { ok: false, reason: "wrong_token" };

  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(expectedToken, "utf8");
  const size = Math.max(providedBuf.length, expectedBuf.length, 32);
  const a = Buffer.alloc(size, 0);
  const b = Buffer.alloc(size, 0);
  providedBuf.copy(a);
  expectedBuf.copy(b);

  // Also compare declared lengths in constant time by XORing a length delta
  // into the padded buffers' final byte — otherwise `Buffer.alloc(size, 0)`
  // would let two different-length tokens with a shared prefix compare
  // equal. This keeps timing constant while making length a discriminant.
  a[size - 1] ^= providedBuf.length & 0xff;
  b[size - 1] ^= expectedBuf.length & 0xff;

  const equal = timingSafeEqual(a, b);
  if (!equal) return { ok: false, reason: "wrong_token" };
  return { ok: true, tokenFingerprint: fingerprintToken(expectedToken) };
}

/**
 * Process-local sliding-window counter of authentication failures.
 * Emits an alert when `threshold` failures occur within `windowMs`, then
 * resets the window so subsequent bursts re-trigger.
 */
export class AuthFailureBurstTracker {
  private readonly windowMs: number;
  private readonly threshold: number;
  private readonly buckets = new Map<string, number[]>();

  constructor(
    private readonly onBurst: AuthFailureBurstEmitter,
    options: { windowMs?: number; threshold?: number } = {},
  ) {
    this.windowMs = options.windowMs ?? BURST_WINDOW_MS;
    this.threshold = options.threshold ?? BURST_THRESHOLD;
  }

  recordFailure(ip: string | null, nowMs: number = Date.now()): void {
    const key = ip ?? "unknown";
    const cutoff = nowMs - this.windowMs;
    const arr = this.buckets.get(key) ?? [];
    const pruned = arr.filter((t) => t >= cutoff);
    pruned.push(nowMs);
    this.buckets.set(key, pruned);

    if (pruned.length >= this.threshold) {
      this.buckets.set(key, []); // reset so next N failures re-trigger
      void this.onBurst({
        ip,
        count: pruned.length,
        windowMs: this.windowMs,
      });
    }
  }
}

interface AuthDecoration {
  correlationId: string;
  actorKind: ExecutionAuditActorKind;
  tokenFingerprint: string | null;
  authReason: "missing_header" | "malformed" | "wrong_token" | null;
}

// Fastify adds request/reply decorators via module augmentation. Instead of
// polluting the global Fastify types, we stash our fields on a dedicated
// symbol so tests can inspect them without wrestling with declaration
// merging across packages.
const AUTH_SYMBOL: unique symbol = Symbol("execution.audit.state");

interface RequestWithAudit extends FastifyRequest {
  [AUTH_SYMBOL]?: AuthDecoration;
}

function getState(req: FastifyRequest): AuthDecoration | undefined {
  return (req as RequestWithAudit)[AUTH_SYMBOL];
}

function setState(req: FastifyRequest, state: AuthDecoration): void {
  (req as RequestWithAudit)[AUTH_SYMBOL] = state;
}

function isUuidV4Like(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export interface RegisterExecutionAuthOptions {
  /** Full Bearer token expected by the server. Empty = every request 401s. */
  token: string;
  /** URL paths (or exact matches) that bypass auth AND audit (e.g. /health). */
  publicPaths: ReadonlySet<string>;
  /** Fire-and-forget audit writer. Failures must never block the request. */
  writeAudit: ExecutionAuditWriter;
  /** Burst tracker for repeated 401s. */
  burstTracker: AuthFailureBurstTracker;
  /** Structured logger for internal warnings; must never receive the token. */
  logger: {
    warn: (obj: unknown, msg?: string) => void;
  };
}

/**
 * Install onRequest + preHandler + onResponse hooks that:
 *   - assign / propagate `x-correlation-id`
 *   - enforce Bearer auth on every non-public path
 *   - persist an audit row exactly once per request (in onResponse)
 */
export function registerExecutionAuth(
  app: FastifyInstance,
  opts: RegisterExecutionAuthOptions,
): void {
  const isPublic = (url: string): boolean => {
    // Strip query string; `url` in Fastify includes it.
    const path = url.split("?", 1)[0];
    return opts.publicPaths.has(path);
  };

  app.addHook("onRequest", (request, reply, done) => {
    const raw = request.headers["x-correlation-id"];
    const incoming = Array.isArray(raw) ? raw[0] : raw;
    const correlationId = isUuidV4Like(incoming) ? incoming : randomUUID();
    setState(request, {
      correlationId,
      actorKind: "unauthenticated",
      tokenFingerprint: null,
      authReason: null,
    });
    reply.header("x-correlation-id", correlationId);
    done();
  });

  app.addHook("preHandler", async (request, reply) => {
    if (isPublic(request.url)) return;
    const state = getState(request);
    if (!state) return; // defensive: onRequest should always run first

    const result = verifyBearerToken(request.headers.authorization, opts.token);
    if (!result.ok) {
      state.actorKind = "unauthenticated";
      state.tokenFingerprint = null;
      state.authReason = result.reason;
      opts.burstTracker.recordFailure(request.ip ?? null);
      await reply.code(401).send({ error: "unauthorized" });
      return reply;
    }
    state.actorKind = "authenticated";
    state.tokenFingerprint = result.tokenFingerprint;
    state.authReason = null;
  });

  app.addHook("onResponse", (request, reply, done) => {
    // Public paths are excluded from audit entirely — /health is polled
    // aggressively and would drown the audit table.
    if (isPublic(request.url)) return done();

    const state = getState(request);
    if (!state) return done();

    const outcome = classifyOutcome(reply.statusCode, state.authReason);
    const record: ExecutionAuditRecord = {
      correlationId: state.correlationId,
      route: request.url.split("?", 1)[0],
      method: request.method,
      actorKind: state.actorKind,
      tokenFingerprint: state.tokenFingerprint,
      ip: request.ip ?? null,
      requestHash: hashRequest({
        url: request.url,
        method: request.method,
        body: request.body,
      }),
      outcome,
      reason: buildReason(reply.statusCode, state.authReason),
    };

    Promise.resolve(opts.writeAudit(record)).catch((err) => {
      opts.logger.warn(
        { err, correlationId: state.correlationId, route: record.route },
        "failed to persist execution audit row",
      );
    });
    done();
  });
}

function classifyOutcome(
  statusCode: number,
  authReason: string | null,
): ExecutionAuditOutcome {
  if (authReason) return "DENY_AUTH";
  if (statusCode === 423) return "DENY_GUARD"; // reserved for PR3
  if (statusCode >= 500) return "ERROR";
  if (statusCode >= 400) return "ERROR";
  return "ALLOW";
}

function buildReason(
  statusCode: number,
  authReason: string | null,
): string | null {
  if (authReason) return authReason;
  if (statusCode >= 400) return `http_${statusCode}`;
  return null;
}

/**
 * Small helper used by `index.ts` to fetch the correlationId when it needs
 * to include the value in its own log lines (in addition to the response
 * header set by the plugin).
 */
export function getCorrelationId(request: FastifyRequest): string | null {
  return getState(request)?.correlationId ?? null;
}
