import { InstrumentRegistry } from "../instruments/registry.js";
import { InstrumentBindingAuthority, type BoundInstrument, type InstrumentBinding } from "../instruments/bindings.js";
import type { Instrument } from "../instruments/types.js";
import { canonicalJson, sha256 } from "./identity.js";

export interface LegacyManagementSnapshot { readonly canonicalVersion: 1; readonly instruments: readonly Instrument[]; readonly bindings: readonly InstrumentBinding[] }
export interface RetainedOwnershipIdentity { readonly instrumentId: string; readonly conId: string; readonly symbol: string; readonly strategy: string | null; readonly clientOrderHash: string | null }
export function createLegacyManagementSnapshot(authority: InstrumentBindingAuthority): { sourceHash: string; canonical: string; snapshot: LegacyManagementSnapshot } {
  const rows = [...authority.listBoundInstruments()].sort((a, b) => a.instrumentId < b.instrumentId ? -1 : a.instrumentId > b.instrumentId ? 1 : 0);
  const snapshot: LegacyManagementSnapshot = { canonicalVersion: 1, instruments: rows.map(row => row.instrument), bindings: rows.map(row => ({ instrumentId: row.instrumentId, conId: row.conId,
    broker: row.broker, localSymbol: row.localSymbol, tradingClass: row.tradingClass, exchange: row.exchange, currency: row.currency, minTick: row.minTick })) };
  const canonical = canonicalJson(JSON.parse(JSON.stringify(snapshot)));
  return { sourceHash: sha256(canonical), canonical, snapshot };
}
export function decodeLegacyManagementSnapshot(canonical: string, sourceHash: string): InstrumentBindingAuthority {
  const fail = (): never => { throw new Error("LEGACY_MANAGEMENT_SNAPSHOT_INVALID"); };
  if (!/^[a-f0-9]{64}$/.test(sourceHash) || sha256(canonical) !== sourceHash) return fail();
  let value: LegacyManagementSnapshot;
  try { value = JSON.parse(canonical) as LegacyManagementSnapshot; } catch { return fail(); }
  if (!value || Object.keys(value).sort().join(",") !== "bindings,canonicalVersion,instruments" || value.canonicalVersion !== 1 || !Array.isArray(value.instruments) || !Array.isArray(value.bindings) || value.instruments.length !== value.bindings.length || canonicalJson(value) !== canonical) return fail();
  try {
    const authority = new InstrumentBindingAuthority(new InstrumentRegistry(value.instruments), value.bindings);
    if (createLegacyManagementSnapshot(authority).canonical !== canonical) return fail();
    return authority;
  } catch { return fail(); }
}
export function validateRetainedOwnership(authority: InstrumentBindingAuthority | null, owned: readonly RetainedOwnershipIdentity[]): void {
  for (const row of owned) {
    const bound = authority?.getBoundInstrument(row.instrumentId);
    if (!bound || String(bound.conId) !== row.conId || bound.brokerSymbol !== row.symbol || !row.clientOrderHash || !/^[a-f0-9]{64}$/.test(row.clientOrderHash)
      || !bound.instrument.trading.executionEnabled || !bound.instrument.executionPolicy || bound.instrument.executionPolicy.strategyId !== row.strategy)
      throw new Error("LEGACY_MANAGEMENT_SNAPSHOT_REQUIRED");
  }
}
function identity(bound: BoundInstrument, comparePrimaryExchange: boolean): string {
  return canonicalJson({ id: bound.instrumentId, conId: bound.conId, broker: bound.broker, symbol: bound.brokerSymbol, exchange: bound.exchange,
    primaryExchange: comparePrimaryExchange ? bound.instrument.primaryExchange ?? null : null, currency: bound.currency, localSymbol: bound.localSymbol, tradingClass: bound.tradingClass, minTick: bound.minTick });
}
export function assertManagementCompatibility(current: InstrumentBindingAuthority, retained: InstrumentBindingAuthority): void {
  for (const old of retained.listBoundInstruments()) {
    const byId = current.getBoundInstrument(old.instrumentId), byConId = current.getBoundInstrumentByConId(old.conId);
    const symbolCollision = current.listBoundInstruments().some(row => row.brokerSymbol === old.brokerSymbol && (row.instrumentId !== old.instrumentId || row.conId !== old.conId));
    if (symbolCollision) throw new Error("CONFIG_RETAINED_IDENTITY_CONFLICT");
    const comparePrimary = old.instrument.primaryExchange !== undefined;
    if ((byId && identity(byId, comparePrimary) !== identity(old, comparePrimary)) || (byConId && identity(byConId, comparePrimary) !== identity(old, comparePrimary))) throw new Error("CONFIG_RETAINED_IDENTITY_CONFLICT");
  }
}
export function buildManagementMonitoringAuthority(current: InstrumentBindingAuthority, retained: InstrumentBindingAuthority | null, owned: readonly RetainedOwnershipIdentity[]): InstrumentBindingAuthority {
  if (!retained) { if (owned.length) throw new Error("LEGACY_MANAGEMENT_SNAPSHOT_REQUIRED"); return current; }
  assertManagementCompatibility(current, retained);
  validateRetainedOwnership(retained, owned);
  const rows = new Map(current.listBoundInstruments().map(row => [row.instrumentId, row]));
  for (const item of owned) {
    const original = retained.getBoundInstrument(item.instrumentId)!;
    const present = rows.get(item.instrumentId);
    const instrument = present?.instrument ?? original.instrument;
    rows.set(item.instrumentId, { ...original, instrument: { ...instrument, trading: { ...instrument.trading, monitoringEnabled: true, executionEnabled: false, signalGenerationEnabled: false, aiAnalysisEnabled: false }, executionPolicy: undefined } });
  }
  const registry = new InstrumentRegistry([...rows.values()].map(row => row.instrument));
  const bindings = [...rows.values()].map(row => ({ instrumentId: row.instrumentId, conId: row.conId, broker: row.broker,
    localSymbol: row.localSymbol, tradingClass: row.tradingClass, exchange: row.exchange, currency: row.currency, minTick: row.minTick }));
  return new InstrumentBindingAuthority(registry, bindings);
}
