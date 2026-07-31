# Market Data Runtime (PR12)

> Dry-run only. Composes ingestion's existing read paths with the
> shared `MarketContextBuilder` and `TradingPipeline` into a single
> HTTP endpoint that returns a raw `TradingPipelineResult`. No
> orders are ever submitted; no rows are ever written.

## Placement (OD-1 for the data-runtime scope)

Hosted **inside `apps/signal-engine`** under `src/runtime/`,
exposing `/runtime/*` routes on the existing Fastify server. Reuses
the existing Redis client, Postgres pool, config loader and logger.

Rejected alternative: a new `apps/orchestrator` process would
duplicate every piece of infrastructure (Docker service, Fastify,
Redis/Postgres clients, health/ready surface, docker-compose entry)
for a single dry-run endpoint. PR13 (Execution Runtime) can
revisit if the write edge needs its own lifecycle; OD-1 for the
write-runtime scope stays open.

## Data sources (all read-only, all pre-existing)

| Section             | Source                                                     | Access                              |
| ------------------- | ---------------------------------------------------------- | ----------------------------------- |
| `price`             | Redis `market-state:<conid>` (written by `apps/ingestion`) | `SignalRepository.getMarketState()` |
| every other section | —                                                          | left `unavailable` in PR12          |

PR12 wires **only the `price` provider**. Other sections stay
`unavailable`, which is a valid `SectionStatus`. No new tables,
no new Redis keys, no new ingestion producers. No candle provider
is included in PR12; the `readRecentCandles` scope is deferred to
whichever PR first adds a technical / candle-driven provider.

## Symbol → conid resolution

`defaultInstrumentRegistry` deliberately ships without broker
`conId`s (they are broker-assigned and roll per contract).
Ingestion resolves them at bootstrap via IBKR and persists them
in the Postgres `instrument_contracts` table keyed by symbol.

The runtime reuses that mapping via `SignalRepositoryContractResolver`:

1. If `Instrument.conId` is present → use it directly (fast path).
2. Otherwise → look up `instrument_contracts` by
   `Instrument.brokerSymbol`.
3. Result is cached with a short, configurable TTL
   (`INSTRUMENT_CONTRACT_CACHE_TTL_S`, default 60 s). When the TTL
   elapses, the next lookup re-queries Postgres. `TTL = 0` disables
   caching entirely.
4. A refresh failure (Postgres throws) does NOT resurrect the
   expired entry — the cache slot is evicted before the query, so
   the caller sees the underlying error rather than a stale hit.

**Contract-roll correctness.** Front-month futures roll every few
weeks; ingestion re-resolves the new conid and updates
`instrument_contracts`. The bounded TTL guarantees the runtime
picks up the new conid within `INSTRUMENT_CONTRACT_CACHE_TTL_S`
of the roll — no restart or redeploy required.

## Payload identity validation (fail-closed)

After reading `market-state:<resolvedConid>` from Redis, the
reader validates that the payload actually belongs to the
requested instrument. A mismatch on `conid` or `symbol`, or an
empty/non-string value in either field, causes the reader to
return `null` — the price section becomes `unavailable` and the
pipeline CANNOT proceed to `SUCCESS` on data that belongs to a
different contract (stale-Redis-after-roll being the most likely
cause).

## Ownership

- `apps/ingestion` remains the sole writer of market state / candles.
- `apps/signal-engine/src/runtime/` is the sole reader for the
  new dry-run flow. The legacy `runAndPersist` pipeline is
  orthogonal and unaffected.
- `packages/shared` owns all domain logic. The runtime hosts NO
  decision, risk, ticket or classification logic — it only
  composes existing shared engines.

## Freshness (fail-closed)

Freshness is derived from the tick's real `observedAt` timestamp,
not the Redis cache hit time. Every failure mode collapses the
`price` section to `stale` or `unavailable`, which prevents a
`SUCCESS` outcome downstream:

| Condition                                               | `Section.status` | Pipeline outcome ceiling |
| ------------------------------------------------------- | ---------------- | ------------------------ |
| Symbol not resolved by ingestion yet                    | `unavailable`    | `FAILURE` / `NO_TRADE`   |
| Redis key missing                                       | `unavailable`    | `FAILURE` / `NO_TRADE`   |
| Redis payload `conid` / `symbol` disagrees with request | `unavailable`    | `FAILURE` / `NO_TRADE`   |
| JSON corrupt / bad timestamp                            | `unavailable`    | `FAILURE` / `NO_TRADE`   |
| `lastPrice` non-finite                                  | `unavailable`    | `FAILURE` / `NO_TRADE`   |
| `observedAt` older than `MARKET_CONTEXT_MAX_TICK_AGE_S` | `stale`          | `FAILURE` / `NO_TRADE`   |
| Redis / Postgres read throws                            | `unavailable`    | `FAILURE` / `NO_TRADE`   |

No default / synthetic price is ever substituted. Missing data
propagates through the shared `DecisionEngine` /
`ExecutionTicketBuilder` guards that already reject stale or
missing prices.

## Dry-run flow

```
POST /runtime/dry-run  { instrumentId, policy }
    │
    ▼
InstrumentRegistry.getInstrumentOrThrow(instrumentId)
    │
    ▼
MarketContextBuilder.build({ instrumentId })
    │   └── PriceContextProvider  ──►  MarketDataRuntimeReader
    │                                        │
    │                                        ▼
    │                              Redis market-state:<conId>
    ▼
TradingPipeline.run(snapshot, instrument, policy)
    │
    ▼
raw TradingPipelineResult (HTTP 200)
```

No `TicketSubmitter`, no HTTP call to `execution-engine`, no
`proposed_orders` insert, no idempotency key allocation, no cron,
no scheduler.

## HTTP surface

| Method | Path               | Purpose                                                                                                          |
| ------ | ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/runtime/health`  | Liveness (200 while process alive)                                                                               |
| `GET`  | `/runtime/ready`   | Readiness — Redis `PING` + Postgres `SELECT 1` (200 or 503). Postgres is required for symbol → conid resolution. |
| `POST` | `/runtime/dry-run` | Registry lookup + snapshot + pipeline; returns raw result                                                        |

Broker / IBKR / execution-engine liveness is **not** part of
readiness — PR12 performs no submission and must not be blocked
by write-edge outages.

Auth is intentionally NOT introduced by PR12 (signal-engine has
none today). PR13 or a follow-up may add auth uniformly across
`/signals/*` and `/runtime/*`.

## Runtime dependencies

- Instrument Registry: `defaultInstrumentRegistry` from `@ikbr/shared`.
- Redis: existing `ioredis` client instance.
- Postgres: existing `pg.Pool` instance.
- Shared engines: `DecisionEngine`, `RiskEngine`, `SignalEngine`,
  `ExecutionTicketBuilder`, `TradingPipeline` — all from
  `@ikbr/shared`, all deterministic.

## Configuration additions

- `RUNTIME_ENABLED` — kill-switch; when `false`, `/runtime/*`
  routes are not registered. Default `true`.
- `MARKET_CONTEXT_MAX_TICK_AGE_S` — TTL override for the `price`
  section. Default `30` s (matches `DEFAULT_FRESHNESS_POLICY`).
- `INSTRUMENT_CONTRACT_CACHE_TTL_S` — TTL for the symbol → conid
  cache in `SignalRepositoryContractResolver`. Bounds the
  contract-roll staleness window. Default `60` s. Set to `0` to
  disable caching.

Not added by PR12 (deferred): `ORCH_LOOP_ENABLED`, retry policy,
reconciliation, execution-engine URL, idempotency key storage,
candle-provider settings.

## PR15.2 — Instrument binding integration

The `ContractResolver` port is wrapped by
`BindingAwareContractResolver` (in
`apps/signal-engine/src/runtime/market-data-reader.ts`). For any
instrument that appears in the shared `INSTRUMENT_BINDINGS_JSON`
authority, the resolver returns the exact operator-selected
`conId` and NEVER consults `instrument_contracts` by
symbol. Unbound instruments continue to use the legacy
symbol → conid lookup.

The identity check inside `SignalRepositoryMarketDataReader`
remains authoritative: the Redis payload's `conid` and `symbol`
MUST agree with what the wrapper returned, or the reader returns
`null` and the price section becomes unavailable.
