import type { CandleTimeframe, InstrumentBindingAuthority, InstrumentRegistry, StrategyInstanceAttributionV1, StrategyTriggerV1, TradingConfigurationV1, TradingStrategyInstanceV1 } from "@ikbr/shared";
import { buildStrategyAttribution } from "@ikbr/shared/trading-config";
import { createConfiguredStrategy } from "../../strategies/strategy-registry.js";
import type { Strategy, StrategySignal } from "../../strategies/strategy.types.js";
import { StrategyPortfolioManager } from "../../portfolio/strategy-portfolio-manager.js";
import type { StrategyContextLoader } from "./strategy-context-loader.js";

export interface ConfiguredStrategyState {
  sync(input: { accountId: string; conId: string; implementationId: string }): Promise<{
    enabled: boolean; permanentlyDisabled: boolean; cooldownUntil?: Date; holdReason?: string;
  }>;
}
export interface ConfiguredStrategyEvaluation {
  readonly kind: "signal" | "no_signal" | "disabled" | "error";
  readonly instrumentId: string;
  readonly strategyAttribution?: StrategyInstanceAttributionV1;
  readonly strategyTrigger?: StrategyTriggerV1;
  readonly signal?: StrategySignal;
  readonly reasons: readonly string[];
  readonly entryAllowed: false;
  readonly entryBlockers: readonly string[];
}
export interface ConfiguredStrategyRuntimeOptions {
  configuration: TradingConfigurationV1;
  effectiveConfigHash: string;
  accountId: string;
  authority: InstrumentBindingAuthority;
  registry: InstrumentRegistry;
  contextLoader: Pick<StrategyContextLoader, "load">;
  state: ConfiguredStrategyState;
  assertEvaluationAllowed(): Promise<void>;
  clock?: () => Date;
  factory?: (instance: TradingStrategyInstanceV1) => Strategy;
}
const domainReasons = new Set([
 "CONFIG_STORE_UNAVAILABLE", "CONFIG_DRIFT", "CONFIG_SERVICE_UNAVAILABLE", "CONFIG_MIGRATION_PREPARATION",
 "PP2_ACCOUNT_ENVIRONMENT_UNAVAILABLE", "PP2_ACCOUNT_ID_UNAVAILABLE", "PP2_ACCOUNT_NOT_ALLOWED",
 "PP2_STATE_CONVERSION_REQUIRED", "PP2_CONVERSION_REQUIRES_DISABLED_WRITES", "PP2_CONVERSION_ROLLOUT_UNAVAILABLE",
 "PP2_CONVERSION_PREPARATION_REQUIRED", "PP2_CONVERSION_PEER_MISMATCH", "PP2_CONVERSION_V2_HISTORY_CONFLICT",
 "PP2_CONVERSION_UNRESOLVED_OWNERSHIP", "PP2_CONVERSION_TRIGGER_CONFLICT", "LEGACY_STATE_UNAVAILABLE", "LEGACY_STATE_TIME_INVALID", "PP2_STATE_TIME_INVALID",
 "OUTCOME_AUTH_UNAVAILABLE", "OUTCOME_UNAVAILABLE", "OUTCOME_TIME_INVALID", "OUTCOME_COMPLETION_UNAVAILABLE",
 "OUTCOME_ACCOUNTING_UNAVAILABLE", "OUTCOME_EXIT_UNAVAILABLE", "OUTCOME_CLOSE_AMBIGUOUS",
]);
const required: readonly CandleTimeframe[] = ["1m", "5m", "1h", "4h", "1d"];
export class ConfiguredStrategyRuntime {
  private readonly objects = new Map<string, Strategy>();
  constructor(private readonly options: ConfiguredStrategyRuntimeOptions) {}
  listInstrumentIds(): readonly string[] { return this.options.configuration.instruments.map(row => row.id); }
  async evaluate(instrumentId: string): Promise<ConfiguredStrategyEvaluation> {
    const result = (kind: ConfiguredStrategyEvaluation["kind"], reasons: string[], rest: Partial<ConfiguredStrategyEvaluation> = {}): ConfiguredStrategyEvaluation =>
      Object.freeze({ ...rest, kind, instrumentId, reasons: Object.freeze(reasons), entryAllowed: false, entryBlockers: Object.freeze(["PP3_EXECUTION_POLICY_UNAVAILABLE", "PP4_RESEARCH_UNAVAILABLE"]) });
    const row = this.options.configuration.instruments.find(i => i.id === instrumentId);
    if (!row) return result("error", ["INSTRUMENT_NOT_CONFIGURED"]);
    if (!row.entryEnabled || !row.monitoringEnabled) return result("disabled", ["ENTRY_DISABLED"]);
    const selection = row.strategySelection;
    const ids = selection.instanceIds;
    if (new Set(ids).size !== ids.length || (selection.mode === "single" ? ids.length !== 1 :
      selection.mode !== "priority" || Object.keys(selection.priorities).length !== ids.length ||
      ids.some(id => !Number.isSafeInteger(selection.priorities[id]) || selection.priorities[id] < 0 || selection.priorities[id] > 1000) ||
      new Set(ids.map(id => selection.priorities[id])).size !== ids.length)) return result("error", ["STRATEGY_SELECTION_INVALID"]);
    const assignments = ids.map(id => this.options.configuration.strategyInstances.find(s => s.id === id));
    if (assignments.some(s => !s)) return result("error", ["STRATEGY_ASSIGNMENT_UNAVAILABLE"]);
    const active = assignments.filter((s): s is TradingStrategyInstanceV1 => !!s?.enabled);
    if (!active.length) return result("disabled", ["STRATEGY_INSTANCE_DISABLED"]);
    try {
      await this.options.assertEvaluationAllowed();
      if (!this.options.accountId?.trim() || this.options.accountId !== this.options.accountId.trim()) return result("error", ["STRATEGY_ACCOUNT_UNAVAILABLE"]);
      const bound = this.options.authority.getBoundInstrument(instrumentId);
      const instrument = this.options.registry.getInstrumentOrThrow(instrumentId);
      if (!bound || bound.conId !== row.contract.conId || bound.brokerSymbol !== row.contract.symbol) return result("error", ["STRATEGY_CONTRACT_MISMATCH"]);
      const states = new Map<string, Awaited<ReturnType<ConfiguredStrategyState["sync"]>>>();
      for (const instance of active) if (!states.has(instance.implementationId)) {
        states.set(instance.implementationId, await this.options.state.sync({ accountId: this.options.accountId, conId: String(bound.conId), implementationId: instance.implementationId }));
      }
      const now = (this.options.clock?.() ?? new Date()).getTime();
      for (const state of states.values()) {
        if (state.holdReason) return result("error", [state.holdReason]);
        if (!state.enabled || state.permanentlyDisabled || (state.cooldownUntil?.getTime() ?? 0) > now) return result("disabled", ["STRATEGY_SAFETY_DISABLED"]);
      }
      const prepared = active.map(instance => {
        const attribution = buildStrategyAttribution(this.options.configuration, instrumentId, instance.id);
        if (attribution.effectiveConfigHash !== this.options.effectiveConfigHash) throw Error("CONFIG_HASH_MISMATCH");
        const key = `${instrumentId}/${instance.id}/${instance.revision}/${attribution.instanceHash}`;
        let strategy = this.objects.get(key);
        if (!strategy) { strategy = (this.options.factory ?? createConfiguredStrategy)(instance); this.objects.set(key, strategy); }
        return { instance, attribution, strategy };
      });
      const timeframes = [...new Set([...required, ...prepared.flatMap(p => [...p.strategy.requiredTimeframes])])];
      const loaded = await this.options.contextLoader.load({ instrument, bound, positionQuantity: 0, timeframes });
      if (loaded.kind === "error") return result("error", [loaded.code]);
      await this.options.assertEvaluationAllowed();
      const candidates: Array<{ signal: StrategySignal; strategyAttribution: StrategyInstanceAttributionV1; priority: number }> = [];
      const reasons: string[] = [];
      for (const { instance, strategy, attribution } of prepared) {
        const outcome = new StrategyPortfolioManager([strategy]).run(loaded.context);
        if (outcome.kind === "error") return result("error", ["STRATEGY_EVALUATION_EXCEPTION"]);
        if (!outcome.selected) { reasons.push(...outcome.rejectionReasons); continue; }
        const signal = outcome.selected.signal;
        if (signal.strategyId !== instance.implementationId || strategy.id !== instance.implementationId || signal.symbol !== row.contract.symbol ||
          !strategy.supportedDirections.includes(signal.direction) || signal.side !== (signal.direction === "LONG" ? "BUY" : "SELL")) return result("error", ["STRATEGY_ATTRIBUTION_MISMATCH"]);
        candidates.push({ signal, strategyAttribution: attribution, priority: selection.mode === "priority" ? selection.priorities[instance.id] : 0 });
      }
      if (new Set(candidates.map(c => c.signal.direction)).size > 1) return result("error", ["STRATEGY_CONFLICT"]);
      candidates.sort((a,b) => b.priority-a.priority || a.strategyAttribution.instanceId.localeCompare(b.strategyAttribution.instanceId));
      const winner = candidates[0];
      if (!winner) return result("no_signal", reasons);
      if (winner.signal.direction !== "LONG") return result("error", ["STRATEGY_DIRECTION_UNSUPPORTED"]);
      const stamp = loaded.context.marketState?.ts;
      const observed = stamp instanceof Date ? stamp.getTime() : typeof stamp === "string" ? Date.parse(stamp) : NaN;
      const triggerNow = (this.options.clock?.() ?? new Date()).getTime();
      if (!Number.isFinite(observed) || observed > triggerNow || triggerNow-observed >= 90_000) return result("error", ["STRATEGY_TRIGGER_UNAVAILABLE"]);
      const strategyTrigger: StrategyTriggerV1 = Object.freeze({ version:1, source:"evaluation_bucket", timeframe:"1m", observedAt:new Date(observed).toISOString(), bucketStartMs:Math.floor(observed/60_000)*60_000 });
      return result("signal", [], { strategyAttribution: winner.strategyAttribution, strategyTrigger,
        signal: Object.freeze({ ...winner.signal, strategyAttribution: winner.strategyAttribution, strategyTrigger }) });
    } catch(error) { return result("error", [error instanceof Error && domainReasons.has(error.message) ? error.message : "STRATEGY_RUNTIME_UNAVAILABLE"]); }
  }
}
