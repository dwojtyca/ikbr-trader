/**
 * Execution Runtime — submitter port + HTTP adapter.
 *
 * The submitter is the ONLY component allowed to talk to
 * `execution-engine`. It carries no domain decisions — signal
 * generation, risk gating, snapshot construction, scheduling and
 * reconciliation all live elsewhere.
 *
 * Retry policy (PR13):
 *   - NO automatic retries at this layer.
 *   - Timeout / connection error / 5xx → `UNKNOWN` outcome.
 *     Broker state must be recovered by a later reconciliation PR.
 *   - HTTP 4xx → deterministic `CONFLICT` (409 idempotency) or
 *     `NOT_SUBMITTED` (400 validation, 423 kill-switch, 401 auth).
 *   - HTTP 200 with `{ outcome }` → mapped to one of the fine-
 *     grained duplicate / pending / submitted kinds. Presence of
 *     the legacy `{ duplicate: true }` field alone is NOT enough
 *     to classify — the PR13 endpoint sends a discriminator so
 *     the runtime can tell "already SUBMITTED" from "terminal
 *     REJECTED" from "still PROPOSED under someone else's claim".
 *
 * Ambiguity is preserved. If the runtime cannot tell whether the
 * broker accepted the order, the caller MUST NOT auto-retry —
 * every ambiguous outcome surfaces as `UNKNOWN` or `PENDING`
 * (both semantically "do not resubmit; wait for reconciliation").
 */

import type { SignalTicket } from "@ikbr/shared";

export interface SubmitInput {
  readonly ticket: SignalTicket;
  readonly strategy: string;
  readonly clientOrderId: string;
  readonly clientOrderHash: string;
}

export interface SubmittedResponseBody {
  readonly outcome?: "SUBMITTED" | "RESUMED";
  readonly execution: {
    readonly orderId?: number;
    readonly accountId: string;
    readonly brokerOrderId: string;
    readonly status: string;
  };
  readonly order?: unknown;
  readonly resumed?: boolean;
}

export interface DuplicateResponseBody {
  readonly outcome:
    | "DUPLICATE_SUBMITTED"
    | "DUPLICATE_TERMINAL"
    | "DUPLICATE_PENDING_AMBIGUOUS"
    | "PENDING_CLAIMED";
  readonly duplicate?: true;
  readonly order: unknown;
}

/**
 * Fine-grained submit outcomes. The runtime layer maps these to the
 * public `ExecutionRuntimeOutcome` union.
 */
export type SubmitResult =
  | { readonly kind: "submitted"; readonly response: SubmittedResponseBody }
  | { readonly kind: "resumed"; readonly response: SubmittedResponseBody }
  | { readonly kind: "duplicate_submitted"; readonly response: DuplicateResponseBody }
  | { readonly kind: "duplicate_terminal"; readonly response: DuplicateResponseBody }
  | { readonly kind: "duplicate_pending_ambiguous"; readonly response: DuplicateResponseBody }
  | { readonly kind: "pending_claimed"; readonly response: DuplicateResponseBody }
  | { readonly kind: "conflict"; readonly message: string }
  | { readonly kind: "not_submitted"; readonly message: string; readonly statusCode: number }
  | { readonly kind: "unknown"; readonly reason: string };

export interface ExecutionTicketSubmitter {
  submit(input: SubmitInput): Promise<SubmitResult>;
}

// ---------------------------------------------------------------------------
// HTTP adapter
// ---------------------------------------------------------------------------

export interface HttpExecutionTicketSubmitterOptions {
  readonly engineUrl: string;
  readonly bearerToken: string;
  readonly requestTimeoutMs: number;
  /**
   * Injectable `fetch` for tests. Defaults to global `fetch`.
   * Kept as `unknown` to avoid coupling test fakes to the exact
   * `RequestInit` typing (test doubles rarely need every field).
   */
  readonly fetchImpl?: typeof fetch;
}

export class HttpExecutionTicketSubmitter implements ExecutionTicketSubmitter {
  readonly #url: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: HttpExecutionTicketSubmitterOptions) {
    if (!options?.engineUrl) {
      throw new Error("HttpExecutionTicketSubmitter: engineUrl is required");
    }
    if (typeof options.bearerToken !== "string") {
      throw new Error("HttpExecutionTicketSubmitter: bearerToken is required");
    }
    if (
      !Number.isFinite(options.requestTimeoutMs) ||
      options.requestTimeoutMs <= 0
    ) {
      throw new Error(
        "HttpExecutionTicketSubmitter: requestTimeoutMs must be > 0",
      );
    }
    this.#url = options.engineUrl.replace(/\/$/, "");
    this.#token = options.bearerToken;
    this.#timeoutMs = options.requestTimeoutMs;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async submit(input: SubmitInput): Promise<SubmitResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(
        `${this.#url}/execution/execute-ticket`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.#token}`,
          },
          body: JSON.stringify({
            ticket: input.ticket,
            persist: true,
            strategy: input.strategy,
            clientOrderId: input.clientOrderId,
            clientOrderHash: input.clientOrderHash,
          }),
          signal: controller.signal,
        },
      );

      const text = await safeReadText(response);
      const parsed = safeParseJson(text);

      if (response.status === 200) {
        if (parsed && typeof parsed === "object") {
          const outcome = (parsed as { outcome?: unknown }).outcome;
          switch (outcome) {
            case "SUBMITTED":
              return {
                kind: "submitted",
                response: parsed as SubmittedResponseBody,
              };
            case "RESUMED":
              return {
                kind: "resumed",
                response: parsed as SubmittedResponseBody,
              };
            case "DUPLICATE_SUBMITTED":
              return {
                kind: "duplicate_submitted",
                response: parsed as DuplicateResponseBody,
              };
            case "DUPLICATE_TERMINAL":
              return {
                kind: "duplicate_terminal",
                response: parsed as DuplicateResponseBody,
              };
            case "DUPLICATE_PENDING_AMBIGUOUS":
              return {
                kind: "duplicate_pending_ambiguous",
                response: parsed as DuplicateResponseBody,
              };
            case "PENDING_CLAIMED":
              return {
                kind: "pending_claimed",
                response: parsed as DuplicateResponseBody,
              };
          }
        }
        // Response body did not carry a known `outcome` — treat as
        // ambiguous. This is defensive: a schema change on the
        // execution-engine side must never fall through to
        // SUBMITTED by accident.
        return {
          kind: "unknown",
          reason:
            "execution-engine returned 200 without a recognised `outcome` field",
        };
      }

      if (response.status === 409) {
        return {
          kind: "conflict",
          message: extractErrorMessage(parsed) ?? "conflict",
        };
      }

      // Every other 4xx is a deterministic rejection. We report the
      // status code so operators can distinguish 400 (validation),
      // 401 (auth), 423 (kill-switch / env-guard), 404 (not found).
      // The message is redacted to `<status> <statusText>` to avoid
      // leaking secrets or internal error strings; a structured
      // reason string is preserved when the response body supplies
      // an `error` or `reason` field.
      if (response.status >= 400 && response.status < 500) {
        return {
          kind: "not_submitted",
          message:
            extractErrorMessage(parsed) ??
            `${response.status} ${response.statusText}`,
          statusCode: response.status,
        };
      }

      // 5xx is ambiguous — we cannot tell if the broker received
      // the order before the server crashed. NO auto-retry.
      return {
        kind: "unknown",
        reason: `execution-engine returned ${response.status} ${response.statusText}`,
      };
    } catch (error) {
      // AbortError → timeout. Any other fetch throw → network
      // error. Both are ambiguous by definition.
      const message =
        error instanceof Error ? error.message : String(error);
      return {
        kind: "unknown",
        reason: /aborted/i.test(message)
          ? `execution-engine request timed out after ${this.#timeoutMs}ms`
          : `execution-engine request failed: ${message}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function safeParseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractErrorMessage(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const err = (parsed as Record<string, unknown>).error;
  const message = (parsed as Record<string, unknown>).message;
  if (typeof err === "string" && err) return err;
  if (typeof message === "string" && message) return message;
  return undefined;
}
