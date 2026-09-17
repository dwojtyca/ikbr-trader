# PR15.5D — ES compatibility decision record

Date: 2026-09-17

## Decision

`INCONCLUSIVE`

The result is not evidence that `momentum_breakout_long_v1` is economically
compatible or incompatible with ES. ES remains unavailable to the production
strategy, and `executionEnabled` remains false.

## Bound evidence

- experiment: `pr15.5d-es-momentum-breakout-long-v1`;
- implementation: `d833146b4a16228d364b082193b7d7ddd891f7ad`;
- specification: `4afee9646d4f8aea18f35effca741c2cc80c82195b5519f6a88161077a65dff6`;
- dataset provenance: `ibkr-es-20250622-20260831-e39a59790324`;
- dataset fingerprint before and after:
  `6dc425610feb44665226228bbd2c561b64504b47588b4dd38d26cc9dab93e026`;
- terminal result fingerprint:
  `efedef18335d2e471023879ea4ffe968a833928f840883f658274c2c30808a45`.

The one authorized POST produced one failed primary run and no stress or
primary-reproduction run. The simulator rejected overlapping contract rows
before processing the first candle. The run recorded zero progress, zero
orders, and zero fills.

## Reason

The immutable dataset correctly retains overlapping raw front- and
next-contract candles needed to establish the roll. The research runner used
the generic loader, which selects every row for a symbol ordered only by
timestamp. It did not project the registered single active contract using
`valid_from` and `valid_to`. The simulator correctly failed closed when it saw
duplicate ES timestamps.

This is an experiment-runner integrity failure, so the pre-registered decision
rule requires `INCONCLUSIVE`. It is not an economic rejection and may not be
relabelled as one.

## Consequence

The durable experiment claim, failed run, and canonical artifact must be
preserved unchanged. The terminal attempt cannot be resumed or rerun under the
same experiment identity. Any correction requires a separately planned and
reviewed remediation, a new implementation identity, a new pre-registered
experiment identity, a newly frozen specification hash, green CI, and explicit
owner authorization of the exact implementation commit and specification hash.
