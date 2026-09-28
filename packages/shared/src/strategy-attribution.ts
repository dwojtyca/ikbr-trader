export interface StrategyInstanceAttributionV1 {
  readonly version: 1;
  readonly implementationId: "momentum_breakout_long_v1";
  readonly instanceId: string;
  readonly instanceRevision: number;
  readonly instanceHash: string;
  readonly effectiveConfigHash: string;
  readonly instrumentId: string;
}

export interface StrategyTriggerV1 {
  readonly version: 1;
  readonly source: "evaluation_bucket";
  readonly timeframe: "1m";
  readonly observedAt: string;
  readonly bucketStartMs: number;
}

function exactObject(value: unknown, keys: readonly string[], reason: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== keys.length || Object.keys(value).sort().join(",") !== [...keys].sort().join(",") ||
      keys.some(key => { const descriptor = Object.getOwnPropertyDescriptor(value, key); return !descriptor || !("value" in descriptor); })) throw new Error(reason);
  return value as Record<string, unknown>;
}

export function parseStrategyAttribution(value: unknown): StrategyInstanceAttributionV1 {
  const reason = "STRATEGY_ATTRIBUTION_INVALID";
  const row = exactObject(value, ["version", "implementationId", "instanceId", "instanceRevision", "instanceHash", "effectiveConfigHash", "instrumentId"], reason);
  const id = (v: unknown) => typeof v === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(v);
  const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  if (row.version !== 1 || row.implementationId !== "momentum_breakout_long_v1" ||
      !id(row.instanceId) || !id(row.instrumentId) || !hash(row.instanceHash) || !hash(row.effectiveConfigHash) ||
      !Number.isSafeInteger(row.instanceRevision) || (row.instanceRevision as number) < 1) throw new Error(reason);
  return Object.freeze({ ...row }) as unknown as StrategyInstanceAttributionV1;
}

export function parseStrategyTrigger(value: unknown): StrategyTriggerV1 {
  const reason = "STRATEGY_TRIGGER_INVALID";
  const row = exactObject(value, ["version", "source", "timeframe", "observedAt", "bucketStartMs"], reason);
  const observed = typeof row.observedAt === "string" ? Date.parse(row.observedAt) : NaN;
  if (row.version !== 1 || row.source !== "evaluation_bucket" || row.timeframe !== "1m" ||
      !Number.isFinite(observed) || new Date(observed).toISOString() !== row.observedAt || observed < 0 ||
      !Number.isSafeInteger(row.bucketStartMs) || Object.is(row.bucketStartMs, -0) ||
      row.bucketStartMs !== Math.floor(observed / 60_000) * 60_000) throw new Error(reason);
  return Object.freeze({ ...row }) as unknown as StrategyTriggerV1;
}

export function strategyTriggerId(trigger: StrategyTriggerV1): string {
  const valid = parseStrategyTrigger(trigger);
  return `evaluation.1m.${valid.bucketStartMs}`;
}
