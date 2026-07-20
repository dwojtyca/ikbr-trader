/**
 * PR15 — deterministic short broker `orderRef` derivation.
 *
 * `orderRef` is a correlation identifier ONLY. IBKR does NOT
 * guarantee broker-side idempotency on `orderRef`; the idempotency
 * contract remains PR13's `client_order_id UNIQUE` + Postgres
 * advisory lock.
 *
 * Rules (see docs/implementation/phase2/PR15_PLAN.md §4):
 *   - never send the raw `clientOrderId` (36+ chars, opaque UUID);
 *   - parent: `co-` + 12-char crockford-base32 hash of
 *     `"v1|" + clientOrderId`;
 *   - children: `co-` + 10-char hash + `-<role><ordinal>` suffix.
 *
 * Length is bounded ≤ 20 characters — well below IBKR's `orderRef`
 * limit. Retries of the same `clientOrderId` produce the same
 * ref (deterministic hash).
 */

import { createHash } from "node:crypto";

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const PARENT_PREFIX = "co-";
const HASH_VERSION = "v1";

const PARENT_HASH_LEN = 12;
const CHILD_HASH_LEN = 10;

const MAX_REF_LEN = 20;

export type BrokerOrderRole = "PARENT" | "TP" | "SL";

/** Structural description of one leg in an order plan. */
export interface OrderPlanLeg {
  readonly role: BrokerOrderRole;
  /** 0 for PARENT; 1..N for bracket-child ladder rungs. */
  readonly ordinal: number;
}

export function deriveParentOrderRef(clientOrderId: string): string {
  return PARENT_PREFIX + hashSlice(clientOrderId, PARENT_HASH_LEN);
}

export function deriveChildOrderRef(
  clientOrderId: string,
  leg: OrderPlanLeg,
): string {
  if (leg.role === "PARENT") return deriveParentOrderRef(clientOrderId);
  const suffix = `-${leg.role.toLowerCase()}${leg.ordinal}`;
  const ref = PARENT_PREFIX + hashSlice(clientOrderId, CHILD_HASH_LEN) + suffix;
  if (ref.length > MAX_REF_LEN) {
    throw new Error(
      `deriveChildOrderRef: role=${leg.role} ordinal=${leg.ordinal} produced ` +
        `ref=${ref} which exceeds MAX_REF_LEN=${MAX_REF_LEN}`,
    );
  }
  return ref;
}

/**
 * Derive a ref for any leg. Parent is `deriveParentOrderRef`,
 * children are `deriveChildOrderRef`.
 */
export function deriveOrderRefForLeg(
  clientOrderId: string,
  leg: OrderPlanLeg,
): string {
  return leg.role === "PARENT"
    ? deriveParentOrderRef(clientOrderId)
    : deriveChildOrderRef(clientOrderId, leg);
}

function hashSlice(clientOrderId: string, chars: number): string {
  if (typeof clientOrderId !== "string" || clientOrderId.length === 0) {
    throw new Error("clientOrderId must be a non-empty string");
  }
  const digest = createHash("sha256")
    .update(`${HASH_VERSION}|${clientOrderId}`)
    .digest();
  return encodeCrockford(digest, chars);
}

function encodeCrockford(bytes: Buffer, chars: number): string {
  // 5 bits per char × chars = bit budget; we walk the buffer bit by bit.
  let out = "";
  let bits = 0;
  let value = 0;
  for (let i = 0; i < bytes.length && out.length < chars; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      bits -= 5;
      const idx = (value >> bits) & 0x1f;
      out += CROCKFORD_ALPHABET[idx];
    }
  }
  return out;
}

export const ORDER_REF_MAX_LEN = MAX_REF_LEN;
export const ORDER_REF_PREFIX = PARENT_PREFIX;
