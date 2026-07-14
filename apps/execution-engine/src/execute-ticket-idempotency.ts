/**
 * PR13 idempotency decision helper.
 *
 * Compares an incoming `clientOrderHash` against the hash stored on
 * the pre-existing `proposed_orders` row (looked up by
 * `client_order_id`) AND takes into account the row's current
 * lifecycle status. The status matters because merely finding a row
 * with a matching hash is NOT proof that the broker ever received
 * the order — an INSERT that succeeded and then crashed before
 * `executePersistedOrder` runs leaves an orphan `PROPOSED` row that
 * must be resumed on retry, NOT reported as a duplicate.
 *
 * Decisions:
 *
 *   - `existing === null`                → `insert`
 *       No previous row; endpoint proceeds with a fresh INSERT.
 *
 *   - hash mismatch OR stored hash NULL  → `conflict`
 *       Same `clientOrderId` reused with different order intent.
 *       Never blind-replay a pre-PR13 row that has no hash.
 *
 *   - hash match, terminal-with-broker  → `duplicate_replay`
 *       `SUBMITTED` / `FILLED` — broker got the order, we can
 *       safely tell the caller "already done, here is the row".
 *
 *   - hash match, terminal-without-submit → `duplicate_terminal`
 *       `REJECTED` / `CANCELLED` / `SUPERSEDED` / `EXPIRED` — a
 *       previous attempt either failed validation or was cancelled.
 *       Never re-submit under the same `clientOrderId`; return the
 *       terminal outcome so the caller can decide (e.g. mint a
 *       fresh key). This is a distinct outcome from `duplicate_replay`
 *       precisely to avoid pretending a rejection was a success.
 *
 *   - hash match, ambiguous submission  → `duplicate_replay`
 *       `PROPOSED` with `executionAttemptedAt` set (or a broker
 *       order id already recorded). The previous call reached
 *       `markExecutionAttempt` — the broker MAY have received the
 *       order before the process died. Reporting `duplicate_replay`
 *       is the ONLY safe outcome; a later reconciliation PR is
 *       responsible for driving the ambiguous row to a terminal
 *       state.
 *
 *   - hash match, safe-to-resume        → `resume`
 *       `PROPOSED` with no `executionAttemptedAt` and no
 *       `brokerOrderId`. The previous call inserted the row and
 *       then crashed before ever contacting the broker. The
 *       endpoint MUST re-run `executePersistedOrder` on the same
 *       row so a broker submission actually happens exactly once.
 */

export type IdempotencyStatus =
  | "PROPOSED"
  | "REJECTED"
  | "SUBMITTED"
  | "FILLED"
  | "CANCELLED"
  | "SUPERSEDED"
  | "EXPIRED";

export interface IdempotencyExistingRecord {
  readonly clientOrderHash: string | null;
  readonly status: IdempotencyStatus;
  readonly executionAttemptedAt: Date | undefined;
  readonly brokerOrderId: string | undefined;
}

export type IdempotencyDecision =
  | { readonly kind: "insert" }
  | { readonly kind: "duplicate_replay" }
  | { readonly kind: "duplicate_terminal" }
  | { readonly kind: "resume" }
  | { readonly kind: "conflict" };

export function decideIdempotency(input: {
  readonly existing: IdempotencyExistingRecord | null;
  readonly incomingHash: string;
}): IdempotencyDecision {
  const { existing, incomingHash } = input;
  if (!existing) return { kind: "insert" };
  if (existing.clientOrderHash === null) return { kind: "conflict" };
  if (existing.clientOrderHash !== incomingHash) return { kind: "conflict" };

  switch (existing.status) {
    case "SUBMITTED":
    case "FILLED":
      return { kind: "duplicate_replay" };
    case "REJECTED":
    case "CANCELLED":
    case "SUPERSEDED":
    case "EXPIRED":
      return { kind: "duplicate_terminal" };
    case "PROPOSED":
      // Ambiguous: an attempt was already made — the broker MAY
      // have accepted before the process died. NEVER resume; a
      // reconciliation PR resolves the row.
      if (
        existing.executionAttemptedAt !== undefined ||
        existing.brokerOrderId !== undefined
      ) {
        return { kind: "duplicate_replay" };
      }
      // Safe path: pure PROPOSED with no evidence of a broker
      // handoff. Retry drives the same row through
      // `executePersistedOrder`.
      return { kind: "resume" };
  }
}
