import type { Broker, BrokerContractKey, Instrument } from "./types.js";

/**
 * Read-only lookup surface for platform instruments.
 *
 * `InstrumentRegistry` is intentionally allocated once (see
 * `defaultInstrumentRegistry` in `./definitions.ts`) and treated as
 * immutable at runtime. All lookups are O(1); listing methods return
 * cached frozen snapshots and do not defensively clone on each call.
 *
 * The class does NOT know about brokers, filesystems, network I/O or
 * signal state — it is a pure in-memory data structure. Adapters (broker
 * connectors, database repositories) are expected to translate registry
 * output to their own contract representations, not the other way around.
 */
export class InstrumentRegistry {
  readonly #byId: ReadonlyMap<string, Instrument>;
  readonly #byBrokerSymbol: ReadonlyMap<string, readonly Instrument[]>;
  readonly #byContractKey: ReadonlyMap<string, Instrument>;
  readonly #all: readonly Instrument[];
  readonly #executionEnabled: readonly Instrument[];
  readonly #signalEnabled: readonly Instrument[];
  readonly #monitoringEnabled: readonly Instrument[];
  readonly #aiEnabled: readonly Instrument[];

  constructor(instruments: readonly Instrument[]) {
    const byId = new Map<string, Instrument>();
    const byContractKey = new Map<string, Instrument>();
    const byBrokerSymbolMutable = new Map<string, Instrument[]>();
    const snapshot: Instrument[] = [];

    for (const source of instruments) {
      InstrumentRegistry.#assertRollInvariant(source);

      // Defensive copy: consumers can hand us a literal today, mutate the
      // literal tomorrow, and the registry must be unaffected. We rebuild
      // each nested section so that freezing the copy cannot leak back to
      // the caller's original object graph either.
      const cloned = InstrumentRegistry.#cloneInstrument(source);
      const frozen = InstrumentRegistry.#deepFreeze(cloned);

      if (byId.has(frozen.id)) {
        throw new Error(
          `InstrumentRegistry: duplicate instrument id "${frozen.id}"`,
        );
      }
      byId.set(frozen.id, frozen);

      const contractKey = InstrumentRegistry.#buildContractKey(frozen);
      if (byContractKey.has(contractKey)) {
        const conflict = byContractKey.get(contractKey);
        throw new Error(
          `InstrumentRegistry: duplicate broker contract key ` +
            `"${contractKey}" — collides with "${conflict?.id}" and "${frozen.id}"`,
        );
      }
      byContractKey.set(contractKey, frozen);

      const brokerSymbolKey = InstrumentRegistry.#brokerSymbolKey(
        frozen.broker,
        frozen.brokerSymbol,
      );
      const bucket = byBrokerSymbolMutable.get(brokerSymbolKey);
      if (bucket) {
        bucket.push(frozen);
      } else {
        byBrokerSymbolMutable.set(brokerSymbolKey, [frozen]);
      }

      snapshot.push(frozen);
    }

    // Freeze bucket arrays so `getByBrokerSymbol` can safely return them
    // by reference.
    const byBrokerSymbolFrozen = new Map<string, readonly Instrument[]>();
    for (const [key, bucket] of byBrokerSymbolMutable) {
      byBrokerSymbolFrozen.set(key, Object.freeze([...bucket]));
    }

    this.#byId = byId;
    this.#byBrokerSymbol = byBrokerSymbolFrozen;
    this.#byContractKey = byContractKey;
    this.#all = Object.freeze(snapshot);
    this.#executionEnabled = Object.freeze(
      this.#all.filter((i) => i.trading.executionEnabled),
    );
    this.#signalEnabled = Object.freeze(
      this.#all.filter((i) => i.trading.signalGenerationEnabled),
    );
    this.#monitoringEnabled = Object.freeze(
      this.#all.filter((i) => i.trading.monitoringEnabled),
    );
    this.#aiEnabled = Object.freeze(
      this.#all.filter((i) => i.trading.aiAnalysisEnabled),
    );
  }

  /**
   * Look up an instrument by its registry id. Returns `undefined` when the
   * id is unknown; callers that require guaranteed presence should use
   * `getInstrumentOrThrow`.
   */
  getInstrument(id: string): Instrument | undefined {
    return this.#byId.get(id);
  }

  /**
   * Look up an instrument by registry id, throwing when absent. Prefer
   * this in configuration / bootstrap paths where a missing id is a
   * programming error, not a valid runtime outcome.
   */
  getInstrumentOrThrow(id: string): Instrument {
    const found = this.#byId.get(id);
    if (!found) {
      throw new Error(`InstrumentRegistry: unknown instrument id "${id}"`);
    }
    return found;
  }

  /**
   * Look up every instrument that shares `(broker, brokerSymbol)`. Returns
   * a frozen snapshot — possibly empty, possibly multi-entry (e.g. every
   * `SI` future the registry knows about, one per expiration).
   *
   * Case-sensitive; broker symbols are canonicalised at definition time.
   */
  getByBrokerSymbol(broker: Broker, brokerSymbol: string): readonly Instrument[] {
    return (
      this.#byBrokerSymbol.get(
        InstrumentRegistry.#brokerSymbolKey(broker, brokerSymbol),
      ) ?? EMPTY_INSTRUMENT_LIST
    );
  }

  /**
   * Look up the single instrument matching a fully-qualified
   * `BrokerContractKey`. Every disambiguator on the key must match
   * exactly (missing on the key + missing on the definition also counts
   * as a match).
   */
  getByBrokerContract(key: BrokerContractKey): Instrument | undefined {
    return this.#byContractKey.get(InstrumentRegistry.#buildContractKey(key));
  }

  /** All instruments in registration order. */
  listAll(): readonly Instrument[] {
    return this.#all;
  }

  /** Instruments the execution-engine is permitted to trade. */
  listExecutionEnabled(): readonly Instrument[] {
    return this.#executionEnabled;
  }

  /** Instruments the signal-engine emits new signals for. */
  listSignalEnabled(): readonly Instrument[] {
    return this.#signalEnabled;
  }

  /** Instruments the ingestion service maintains market state for. */
  listMonitoringEnabled(): readonly Instrument[] {
    return this.#monitoringEnabled;
  }

  /** Instruments the llm-agent may reason about. */
  listAiEnabled(): readonly Instrument[] {
    return this.#aiEnabled;
  }

  static #brokerSymbolKey(broker: Broker, brokerSymbol: string): string {
    return `${broker}|${brokerSymbol}`;
  }

  static #buildContractKey(source: {
    broker: Broker;
    brokerSymbol: string;
    exchange: string;
    currency: string;
    tradingClass?: string;
    localSymbol?: string;
    conId?: number;
  }): string {
    const parts: readonly string[] = [
      source.broker,
      source.exchange,
      source.currency,
      source.brokerSymbol,
      source.tradingClass ?? "",
      source.localSymbol ?? "",
      source.conId != null ? String(source.conId) : "",
    ];
    return parts.join("|");
  }

  static #assertRollInvariant(instrument: Instrument): void {
    if (instrument.assetClass === "future" && !instrument.roll) {
      throw new Error(
        `InstrumentRegistry: instrument "${instrument.id}" is a future ` +
          `but has no roll section`,
      );
    }
    if (instrument.assetClass !== "future" && instrument.roll) {
      throw new Error(
        `InstrumentRegistry: instrument "${instrument.id}" is not a future ` +
          `(assetClass="${instrument.assetClass}") but defines a roll section`,
      );
    }
  }

  static #cloneInstrument(source: Instrument): Instrument {
    return {
      id: source.id,
      displayName: source.displayName,
      assetClass: source.assetClass,
      broker: source.broker,
      brokerSymbol: source.brokerSymbol,
      exchange: source.exchange,
      currency: source.currency,
      primaryExchange: source.primaryExchange,
      conId: source.conId,
      localSymbol: source.localSymbol,
      tradingClass: source.tradingClass,
      trading: { ...source.trading },
      risk: { ...source.risk },
      session: { ...source.session },
      roll: source.roll ? { ...source.roll } : undefined,
      metadata: {
        tags: [...source.metadata.tags],
        sector: source.metadata.sector,
        description: source.metadata.description,
      },
    };
  }

  static #deepFreeze<T>(value: T): T {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
      return value;
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
      InstrumentRegistry.#deepFreeze(child);
    }
    Object.freeze(value);
    return value;
  }
}

const EMPTY_INSTRUMENT_LIST: readonly Instrument[] = Object.freeze([]);
