/**
 * PR15.3 r3 (hostile-review Finding 1) — Closed exemption list for
 * the `TRADING_ENABLED` write guard applied to every mutating
 * `/execution/*` request.
 *
 * Historically the guard exempted the entire
 * `/execution/reconciliation/` prefix. That was too broad: it
 * silently opted every future route under that prefix into the
 * exemption. It was ALSO too narrow: it forbade a running-cost
 * `POST /execution/cancel-proposed/:id` while writes were disabled,
 * which meant the runbook Phase D / abort procedure had NO audited
 * way to neutralise an existing broker order — writes-off was
 * therefore worse than useless during an incident.
 *
 * Design invariants for this list:
 *
 * 1. Every entry is (a) risk-reducing without creating new
 *    exposure, OR (b) a diagnostic-only operator path already
 *    gated by its own secondary token (reconciliation resolve).
 * 2. Match is EXACT — endpoint URL (with :id parametrised) plus
 *    the HTTP method. No open-ended prefix wildcards.
 * 3. Bearer auth and audit run BEFORE this exemption and are
 *    NEVER bypassed.
 * 4. `execute-ticket`, `execute-proposed/:id`, `bootstrap`,
 *    `refresh-position-snapshot`, `alerts/test`, and legacy
 *    `POST /execution/reconciliation` (no trailing slash) MUST
 *    stay under the guard — none of them reduce broker exposure.
 * 5. `reject-proposed/:id` marks a local row REJECTED without
 *    contacting the broker; it does not reduce broker exposure.
 *    It stays under the guard to keep the exemption minimal.
 *
 * The list is exported as a plain array so tests and future
 * additions get one central source of truth. Any addition here
 * is a policy change that MUST be reviewed against the
 * invariants above.
 */

export type WriteGuardHttpMethod = "POST" | "PUT" | "PATCH" | "DELETE";

export interface WriteGuardExemption {
  readonly method: WriteGuardHttpMethod;
  /**
   * Fastify-style route path AS DECLARED at registration time
   * (parameters as `:id`, no query string). Matching against
   * `FastifyRequest.routeOptions.url` avoids param-value or
   * query-string smuggling around the exemption.
   */
  readonly routePath: string;
  /** Short human-readable reason surfaced in code review. */
  readonly rationale: string;
}

export const WRITE_GUARD_EXEMPT_ROUTES: readonly WriteGuardExemption[] = [
  {
    method: "POST",
    routePath: "/execution/cancel-proposed/:id",
    rationale:
      "Risk-reducing: cancels an existing broker order. Required by " +
      "the Paper Entry E2E runbook Phase D / abort procedure so an " +
      "operator can neutralise broker exposure while writes are " +
      "administratively paused.",
  },
  {
    method: "POST",
    routePath: "/execution/reconciliation/run",
    rationale:
      "PR15 §8 — operator-triggered reconciliation. Read-only against " +
      "the broker; no order is created or modified.",
  },
  {
    method: "POST",
    routePath: "/execution/reconciliation/holds/:id/acknowledge",
    rationale:
      "PR15 §8 — acknowledge a reconciliation hold. Does not touch " +
      "broker state; still bearer + audit protected.",
  },
  {
    method: "POST",
    routePath: "/execution/reconciliation/holds/:id/resolve",
    rationale:
      "PR15 §8 — resolve a reconciliation hold. Gated by a SECONDARY " +
      "resolve token in addition to bearer + audit. Any resolution " +
      "that would submit a broker order goes through the guarded " +
      "submission path, not this endpoint.",
  },
];

/**
 * Predicate consumed by the Fastify `preHandler` hook in
 * `apps/execution-engine/src/index.ts`. Returns `true` iff the
 * inbound request matches an explicit entry in
 * `WRITE_GUARD_EXEMPT_ROUTES`.
 *
 * @param method HTTP method (case-insensitive; upper-cased before matching).
 * @param routePath Fastify's declared route path
 *   (`request.routeOptions.url`) when present, falling back to the
 *   raw request URL. Callers MUST NOT feed the query-stringed URL
 *   directly to avoid false negatives on `?trace=1` etc.
 */
export function isWriteGuardExempt(
  method: string,
  routePath: string | undefined,
): boolean {
  if (!routePath) return false;
  const upperMethod = method.toUpperCase();
  // Strip a stray query string defensively — Fastify's routeOptions.url
  // never carries one, but a caller that passes request.url might.
  const idx = routePath.indexOf("?");
  const cleanPath = idx >= 0 ? routePath.slice(0, idx) : routePath;
  for (const entry of WRITE_GUARD_EXEMPT_ROUTES) {
    if (entry.method === upperMethod && entry.routePath === cleanPath) {
      return true;
    }
  }
  return false;
}
