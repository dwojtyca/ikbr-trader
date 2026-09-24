/**
 * PR15.2 — bootstrap wiring for the server-side
 * `InstrumentBindingAuthority` used by execution-engine.
 *
 * The authority is composed at startup from:
 *   - the shared, deep-frozen `defaultInstrumentRegistry`, and
 *   - the operator-supplied `INSTRUMENT_BINDINGS_JSON` payload.
 *
 * Execution-engine deliberately builds its OWN authority instead
 * of trusting one propagated by signal-engine — the whole point
 * of the identity check on `POST /execution/execute-ticket` is
 * that the caller cannot influence server policy. Any mismatch
 * between the payload's `instrumentId` / `instrument` / `conid`
 * and the server-resolved binding is rejected before repository
 * mutation and broker dispatch.
 *
 * Failure semantics:
 *   - malformed JSON, unknown id, tuple mismatch, duplicate id,
 *     duplicate conId → throw at startup so the process refuses
 *     to serve traffic;
 *   - empty / missing input → an empty authority is returned;
 *     Phase 2 write endpoints then reject every bound submission
 *     with `INSTRUMENT_BINDING_UNAVAILABLE`.
 */

import {
  buildInstrumentBindingAuthority,
  defaultInstrumentRegistry,
  InstrumentBindingAuthority,
  type InstrumentBindingParseError,
  type InstrumentRegistry,
} from "@ikbr/shared";

export class InstrumentBindingConfigError extends Error {
  readonly errors: readonly InstrumentBindingParseError[];
  constructor(errors: readonly InstrumentBindingParseError[]) {
    // NEVER include the raw payload in the error message — the
    // parser is careful to surface only index + reason.
    const summary = errors
      .slice(0, 5)
      .map(
        (e) =>
          `#${e.index}${
            e.instrumentId ? ` (${e.instrumentId})` : ""
          }: ${e.message}`,
      )
      .join("; ");
    super(
      `INSTRUMENT_BINDINGS_JSON is invalid — refusing to start. ${summary}` +
        (errors.length > 5 ? ` (+${errors.length - 5} more)` : ""),
    );
    this.name = "InstrumentBindingConfigError";
    this.errors = errors;
  }
}

/**
 * Build the execution-engine's `InstrumentBindingAuthority`.
 * Throws `InstrumentBindingConfigError` on any validation
 * failure — the caller MUST let it propagate to process exit.
 */
export function buildExecutionInstrumentBindingAuthority(
  rawInput: string | undefined,
  registry: InstrumentRegistry = defaultInstrumentRegistry,
): InstrumentBindingAuthority {
  const result = buildInstrumentBindingAuthority(
    rawInput ?? "",
    registry,
  );
  if (!result.ok) throw new InstrumentBindingConfigError(result.errors);
  return result.authority;
}
