/**
 * PR15 — canonical position/order identity for reconciliation
 * matching.
 *
 * Rules (see docs/implementation/phase2/PR15_PLAN.md §2):
 *   1. Both sides expose `conId` and `accountId` →
 *      `identity_key = "conid:<accountId>|<conId>"`.
 *   2. Otherwise → symbol fallback:
 *      `identity_key = "sym:<accountId>|<symbol>|<secType>|<exchange>|<currency>"`
 *      Each field lowercased; empty string for missing pieces.
 *   3. Missing accountId → `identity_ambiguous`; the runner must
 *      NEVER aggregate such rows across accounts.
 *
 * Two identical-symbol futures on different exchanges MUST produce
 * different identity keys.
 */

export interface PositionIdentityFields {
  readonly accountId: string | null | undefined;
  readonly conId?: string | null;
  readonly symbol?: string | null;
  readonly secType?: string | null;
  readonly exchange?: string | null;
  readonly currency?: string | null;
}

export interface CanonicalIdentity {
  readonly identityKey: string;
  readonly ambiguous: boolean;
  readonly accountId: string;
  readonly conId: string | null;
  readonly symbol: string;
  readonly secType: string | null;
  readonly exchange: string | null;
  readonly currency: string | null;
}

export const IDENTITY_AMBIGUOUS_KEY = "ambiguous:no_account";

export function canonicaliseIdentity(
  fields: PositionIdentityFields,
): CanonicalIdentity {
  const accountId = normaliseRequired(fields.accountId);
  if (!accountId) {
    // Explicit ambiguous — caller must not aggregate.
    return {
      identityKey: IDENTITY_AMBIGUOUS_KEY,
      ambiguous: true,
      accountId: "",
      conId: normaliseOptional(fields.conId),
      symbol: normaliseRequired(fields.symbol) ?? "",
      secType: normaliseOptional(fields.secType),
      exchange: normaliseOptional(fields.exchange),
      currency: normaliseOptional(fields.currency),
    };
  }
  const conId = normaliseOptional(fields.conId);
  const symbol = normaliseRequired(fields.symbol) ?? "";
  const secType = normaliseOptional(fields.secType);
  const exchange = normaliseOptional(fields.exchange);
  const currency = normaliseOptional(fields.currency);
  const identityKey = conId
    ? `conid:${accountId}|${conId}`
    : `sym:${accountId}|${symbol.toLowerCase()}|${(secType ?? "").toLowerCase()}|${(exchange ?? "").toLowerCase()}|${(currency ?? "").toLowerCase()}`;
  return {
    identityKey,
    ambiguous: false,
    accountId,
    conId,
    symbol,
    secType,
    exchange,
    currency,
  };
}

function normaliseRequired(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s.length === 0 ? null : s;
}

function normaliseOptional(value: unknown): string | null {
  return normaliseRequired(value);
}
