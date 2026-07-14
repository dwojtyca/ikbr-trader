/**
 * PR14 round-9 blocker — generation-aware refresh coordinator
 * extracted from `index.ts` so it can be unit-tested with a
 * FakeRepo + FakeBroker.
 *
 * The coordinator solves the invalidate-during-refresh race:
 * a fill callback that fires WHILE a refresh is in flight and
 * calls `refreshBrokerPositionSnapshot` again must NOT be
 * silently coalesced onto the older refresh — otherwise the
 * older refresh's `stale_generation` outcome leaves the write
 * path fail-closed forever.
 *
 * Behaviour contract:
 *   1. Public entry `refreshBrokerPositionSnapshot(accountId)`
 *      coalesces onto the running loop for that account.
 *   2. The loop keeps iterating (begin → fetch → complete)
 *      until the persisted state is `complete=true`.
 *   3. Each iteration bumps generation (via `begin`). If a
 *      concurrent invalidation bumps generation between our
 *      `begin` and our `complete`, our `complete` returns
 *      `stale_generation`; the loop reads status and — because
 *      status.complete is false — runs another iteration.
 *   4. On unrecoverable failure (broker fetch, begin, complete
 *      or status read) the loop marks health=failed and exits;
 *      `complete=false` persists and the write path stays
 *      fail-closed until the next successful refresh.
 *   5. `MAX_REFRESH_LOOP_ITERATIONS` bounds pathological churn.
 *      Exhaustion marks health=failed.
 *
 * The coordinator is agnostic to the underlying refresh
 * primitives — it depends only on a small `Deps` port
 * satisfied both by the production repo/tws pair and by the
 * FakeRepo/FakeBroker in the tests.
 */

export const MAX_REFRESH_LOOP_ITERATIONS = 8;

export type SnapshotHealth =
  | { readonly kind: "never" }
  | { readonly kind: "healthy"; readonly at: Date }
  | { readonly kind: "in_flight"; readonly startedAt: Date }
  | {
      readonly kind: "failed";
      readonly at: Date;
      readonly error: string;
    };

export interface RefreshCoordinatorDeps {
  readonly sessionId: string;
  readonly now: () => Date;
  readonly log: {
    readonly info: (obj: unknown, msg?: string) => void;
    readonly warn: (obj: unknown, msg?: string) => void;
    readonly error: (obj: unknown, msg?: string) => void;
  };
  readonly beginRefresh: (input: {
    accountId: string;
    sessionId: string;
    observedAt: Date;
  }) => Promise<{ generation: number }>;
  readonly fetchBrokerSnapshot: (accountId: string) => Promise<{
    retrievedAt: string;
    positions: ReadonlyArray<{
      symbol: string;
      conid?: number | string;
      position: number;
    }>;
  }>;
  readonly completeRefresh: (input: {
    accountId: string;
    sessionId: string;
    observedAt: Date;
    generation: number;
    positions: ReadonlyArray<{
      instrument: string;
      conid?: string;
      quantity: number;
    }>;
  }) => Promise<
    | { kind: "completed" }
    | { kind: "stale_generation"; currentGeneration: number }
  >;
  readonly getStatus: (accountId: string) => Promise<
    | { kind: "missing" }
    | {
        kind: "present";
        sessionId: string;
        observedAt: Date;
        complete: boolean;
        generation: number;
      }
  >;
}

export class RefreshCoordinator {
  readonly #deps: RefreshCoordinatorDeps;
  readonly #health = new Map<string, SnapshotHealth>();
  readonly #inFlight = new Map<string, Promise<void>>();

  constructor(deps: RefreshCoordinatorDeps) {
    this.#deps = deps;
  }

  readonly #desiredGeneration = new Map<string, number>();
  readonly #invalidationVersion = new Map<string, number>();

  health(accountId: string): SnapshotHealth {
    return this.#health.get(accountId) ?? { kind: "never" };
  }

  refresh(accountId: string): Promise<void> {
    const existing = this.#inFlight.get(accountId);
    if (existing) return existing;
    const promise = this.#runLoop(accountId).finally(() => {
      this.#inFlight.delete(accountId);
    });
    this.#inFlight.set(accountId, promise);
    return promise;
  }

  /**
   * Round-10: an invalidation carries the NEW generation it
   * produced. The coordinator tracks the max seen (`desired`)
   * and bumps `invalidationVersion` so the finalisation gate
   * can detect an invalidation that landed AFTER the loop's
   * final `getStatus` but BEFORE it set `healthy`.
   */
  markInvalidated(accountId: string, generation: number): void {
    const prev = this.#desiredGeneration.get(accountId) ?? 0;
    if (generation > prev) this.#desiredGeneration.set(accountId, generation);
    this.#invalidationVersion.set(
      accountId,
      (this.#invalidationVersion.get(accountId) ?? 0) + 1,
    );
    const current = this.#health.get(accountId);
    if (current?.kind === "in_flight") return;
    this.#health.set(accountId, {
      kind: "in_flight",
      startedAt: this.#deps.now(),
    });
  }

  async #runLoop(accountId: string): Promise<void> {
    if (this.#health.get(accountId)?.kind !== "in_flight") {
      this.#health.set(accountId, {
        kind: "in_flight",
        startedAt: this.#deps.now(),
      });
    }
    for (let iter = 0; iter < MAX_REFRESH_LOOP_ITERATIONS; iter++) {
      const iterStartedAt = this.#deps.now();
      let generation: number;
      try {
        ({ generation } = await this.#deps.beginRefresh({
          accountId,
          sessionId: this.#deps.sessionId,
          observedAt: iterStartedAt,
        }));
      } catch (error) {
        this.#markFailed(accountId, (error as Error).message);
        this.#deps.log.error(
          { err: error, accountId },
          "refresh-coordinator: begin failed",
        );
        return;
      }
      // Every begin bumps generation → it becomes at least the
      // desired minimum for THIS iteration.
      const prevDesired = this.#desiredGeneration.get(accountId) ?? 0;
      if (generation > prevDesired) {
        this.#desiredGeneration.set(accountId, generation);
      }
      let brokerSnapshot;
      try {
        brokerSnapshot = await this.#deps.fetchBrokerSnapshot(accountId);
      } catch (error) {
        this.#markFailed(accountId, (error as Error).message);
        this.#deps.log.error(
          { err: error, accountId, generation },
          "refresh-coordinator: broker fetch failed",
        );
        return;
      }
      const observedAt = new Date(brokerSnapshot.retrievedAt);
      let completeOutcome;
      try {
        completeOutcome = await this.#deps.completeRefresh({
          accountId,
          sessionId: this.#deps.sessionId,
          observedAt,
          generation,
          positions: brokerSnapshot.positions.map((p) => ({
            instrument: p.symbol,
            ...(p.conid !== undefined ? { conid: String(p.conid) } : {}),
            quantity: p.position,
          })),
        });
      } catch (error) {
        this.#markFailed(accountId, (error as Error).message);
        this.#deps.log.error(
          { err: error, accountId, generation },
          "refresh-coordinator: complete failed",
        );
        return;
      }
      // Round-10 finalisation gate: capture the invalidation
      // version BEFORE the final status read so an invalidation
      // landing between that read and the healthy set is
      // detected and forces another iteration.
      const versionBefore =
        this.#invalidationVersion.get(accountId) ?? 0;
      let status;
      try {
        status = await this.#deps.getStatus(accountId);
      } catch (error) {
        this.#markFailed(accountId, (error as Error).message);
        return;
      }
      const desired = this.#desiredGeneration.get(accountId) ?? 0;
      const versionAfter =
        this.#invalidationVersion.get(accountId) ?? 0;
      const canFinalise =
        status.kind === "present" &&
        status.complete === true &&
        status.sessionId === this.#deps.sessionId &&
        status.generation >= desired &&
        versionAfter === versionBefore;
      if (canFinalise && status.kind === "present") {
        this.#health.set(accountId, {
          kind: "healthy",
          at: status.observedAt,
        });
        if (completeOutcome.kind === "stale_generation") {
          this.#deps.log.info(
            {
              accountId,
              ourGeneration: generation,
              currentGeneration: completeOutcome.currentGeneration,
            },
            "refresh-coordinator: newer refresh completed on our behalf",
          );
        }
        return;
      }
      this.#deps.log.info(
        {
          accountId,
          iteration: iter + 1,
          ourGeneration: generation,
          desiredGeneration: desired,
          statusSession:
            status.kind === "present" ? status.sessionId : null,
          ownSession: this.#deps.sessionId,
          statusComplete:
            status.kind === "present" ? status.complete : null,
          invalidationRaced: versionAfter !== versionBefore,
          outcome: completeOutcome.kind,
        },
        "refresh-coordinator: rerun required",
      );
    }
    this.#markFailed(
      accountId,
      `refresh did not converge after ${MAX_REFRESH_LOOP_ITERATIONS} attempts`,
    );
    this.#deps.log.error(
      { accountId, maxIterations: MAX_REFRESH_LOOP_ITERATIONS },
      "refresh-coordinator: loop exhausted",
    );
  }

  #markFailed(accountId: string, error: string): void {
    this.#health.set(accountId, {
      kind: "failed",
      at: this.#deps.now(),
      error,
    });
  }
}
