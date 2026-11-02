# Marketaux payload diagnostics amendment

Status: independent critical plan review ACCEPTED by `/root/automatic_startup_plan_review` on 2026-10-28; implementation authorized by lead. Diagnostics use fixed labels only; no parser acceptance change.

## Observed release evidence

Read-only inspection after release `4727ed8` on 2026-10-28 established:

- The old WSH PREPARED challenge received an exact-hash automatic read-recovery disposition at 14:06:24.206 UTC. Fresh AAPL and PKO WSH attempts succeeded with confirmed cleanup. The initial maintenance error preceded that disposition; it was not a permanent startup deadlock.
- PKO Marketaux completed both passes successfully at 14:07:24.651 UTC.
- AAPL Marketaux pass 1, page 1 received a successful transport outcome at 14:07:24.964 UTC, then ended FAILED/HARD with `RESEARCH_MARKETAUX_PAYLOAD_INVALID` at 14:07:24.994 UTC.
- The stored diagnostic contains unavailable original details. The parser collapses distinct metadata, article, timestamp and enrichment failures to the same bare error. Raw response bytes are not retained. The exact failed predicate cannot be reconstructed from the stored hash or asserted from speculation.
- Operational `RESEARCH_MARKETAUX_ON_DEMAND=false`. The regular scheduler invokes refresh independently of entry readiness. `claimMarketauxAttempt` excludes recovered UNKNOWN predecessors and does not exclude a terminal HARD attempt from future scheduling. Its one-hour lower bound makes the next AAPL attempt eligible at **2026-10-28 15:07:24.680 UTC**; the existing minute tick may execute later. This is a new scheduled attempt, not replay of the failed request. Budgets and permissions still apply.

## Bounded implementation

Own `apps/llm-agent/src/research-marketaux.ts` and its existing parser test file `research-marketaux.test.ts`. Add a narrowly scoped propagation assertion to an existing refresh/failure test only if parser-level `captureResearchSourceError` coverage cannot prove the persisted error contract. No scheduler, database, migration, configuration, provider request or broker behavior changes are authorized by this amendment.

Replace the bare payload error construction with `ResearchSourceFailure("RESEARCH_MARKETAUX_PAYLOAD_INVALID", cause)`. The cause is a named `MarketauxPayloadValidationError`; its message contains only code-authored fixed field/constraint identifiers and, where useful, bounded numeric counts or fixed type labels. Never include provider string values, titles, URLs, article IDs, timestamps, payload snippets, configuration identifiers, keys or account IDs. Prefer fixed identifiers alone where counts add no diagnostic value.

Give each existing rejection a distinguishable fixed predicate: root/meta object, provider error envelope, data array, individual metadata integer, pagination cardinality/mismatch, article object/UUID/title/URL/entities/similar, entity object, timestamp type/format/calendar validity, optional description/snippet type/length/control characters, and sentiment type/range. Splitting a compound condition is permitted only in its original evaluation order and with exactly equivalent rejection behavior. Existing domain-specific errors (entity mismatch, duplicate UUID, outside-query time, result limit, changed results) retain their codes and behavior. Keep the capacity diagnostic already present.

All existing bounds, exact entity matching, UTC timestamp acceptance, pagination completeness, two-pass checks, enrichment requirements and retained evidence rules remain unchanged. No raw payload persistence is introduced. Historical failure records remain immutable and do not acquire invented explanations.

## Acceptance and validation

1. Existing parser valid/invalid fixtures retain the same pass/fail outcome and external `RESEARCH_MARKETAUX_PAYLOAD_INVALID` code.
2. Fixtures distinguish the fixed predicate families above, including invalid metadata/cardinality, article identity/URL/shape, timestamp, description/snippet and sentiment.
3. A fixture containing distinctive secret-like provider strings proves none appears in the captured diagnostic; only fixed field/constraint/type labels and permitted bounded numbers may appear.
4. `captureResearchSourceError` retains the named diagnostic and safe detail through the existing failure path. Tests must not fabricate a provider cause for old failures.
5. Focused tests, lint and typecheck pass; repository-required full validation and clean Docker build remain the lead's rollout responsibility. Independent implementation review is distinct from this plan review.
6. After authorized deployment, inspect the next normal scheduler attempt and its persisted sanitized cause. Do not make an ad hoc provider request or reset/replay the failed attempt. If the next attempt succeeds, report that no failed-field evidence was obtained rather than inventing a cause.

## Separate finding, not changed here

`ResearchStore.marketauxAdmissionReasons` currently selects recovered UNKNOWN rows without the recovery exclusion used by `claimMarketauxAttempt` and the supplementary status scan. This explains the old `RECOVERED` plus unresolved-readiness contradiction before a fresh successful periodic attempt. It warrants a separate receipt-aware admission contract and PostgreSQL tests, especially for on-demand-only scheduling. This amendment does not weaken that hold or attempt to solve it through parser diagnostics.
