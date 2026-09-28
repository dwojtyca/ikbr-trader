import { MOMENTUM_CONFIGURATION_DEFAULTS_V1 } from "./defaults.js";
import type {
  MomentumConfigurationParametersV1,
  TradingConfigurationIssue,
  TradingConfigurationParseResult,
  TradingConfigurationV1,
} from "./types.js";

const MAX_ISSUES = 100;
const MAX_JSON_BYTES = 1024 * 1024;
const ROOT_KEYS = ["schemaVersion", "strategyInstances", "instruments", "accountPolicies", "entryPolicies", "executionPolicies", "riskPolicies", "researchPolicies", "issuerMappings"];
const PROTOTYPE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const ID = /^[a-z][a-z0-9_]{0,63}$/;
const SYMBOL = /^[A-Z0-9][A-Z0-9 ._-]{0,31}$/;
const VENUES = new Set(["WSE", "NASDAQ", "NYSE", "AMEX"]);
const FIELD_MESSAGES: Record<string, string> = {
  INVALID_JSON: "Input must be valid JSON.", INVALID_TYPE: "Value has an invalid type.",
  UNKNOWN_FIELD: "Field is not supported by this schema version.", UNSUPPORTED_VERSION: "Schema version is not supported.",
  INVALID_VALUE: "Value is outside the supported schema.", DUPLICATE_ID: "Identifier is duplicated.",
  DUPLICATE_IDENTITY: "Instrument identity is duplicated.", MISSING_REFERENCE: "Reference does not resolve to one row.",
  UNSUPPORTED_IMPLEMENTATION: "Strategy implementation is not supported.",
  UNSUPPORTED_CAPABILITY: "Capability is not supported by this schema version.",
  CONTRADICTORY_POLICY: "Policy conflicts with the instrument contract.", LIMIT_EXCEEDED: "Schema limit is exceeded.",
};

type Obj = Record<string, unknown>;
class Validator {
  readonly issues: TradingConfigurationIssue[] = [];
  add(path: string, code: string): void {
    if (this.issues.length < MAX_ISSUES) this.issues.push({ path, code, message: FIELD_MESSAGES[code] ?? FIELD_MESSAGES.INVALID_VALUE });
  }
  object(value: unknown, path: string, keys: readonly string[]): Obj | undefined {
    if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      this.add(path, "INVALID_TYPE"); return undefined;
    }
    const obj = value as Obj;
    for (const key of Object.keys(obj)) {
      if (PROTOTYPE_KEYS.has(key)) this.add(path, "INVALID_VALUE");
      else if (!keys.includes(key)) this.add(path, "UNKNOWN_FIELD");
    }
    return obj;
  }
  required(obj: Obj | undefined, key: string, path: string): unknown {
    if (!obj || !Object.hasOwn(obj, key)) { this.add(`${path}.${key}`, "INVALID_VALUE"); return undefined; }
    return obj[key];
  }
  string(value: unknown, path: string, pattern?: RegExp, max = 64): string {
    if (typeof value !== "string") { this.add(path, "INVALID_TYPE"); return ""; }
    if (!value.length || value.length > max || /[^\x20-\x7e]/.test(value) || (pattern && !pattern.test(value)) || (pattern === SYMBOL && value.trim() !== value)) this.add(path, "INVALID_VALUE");
    return value;
  }
  id(value: unknown, path: string): string { return this.string(value, path, ID); }
  bool(value: unknown, path: string): boolean {
    if (typeof value !== "boolean") { this.add(path, "INVALID_TYPE"); return false; }
    return value;
  }
  number(value: unknown, path: string, min: number, max: number, integer = false, positive = false): number {
    if (typeof value !== "number") { this.add(path, "INVALID_TYPE"); return 0; }
    if (!Number.isFinite(value) || Object.is(value, -0) || value < min || value > max || (integer && !Number.isSafeInteger(value)) || (positive && value <= 0)) this.add(path, "INVALID_VALUE");
    return value;
  }
  literal<T extends string | number | boolean>(value: unknown, path: string, allowed: readonly T[], code = "UNSUPPORTED_CAPABILITY"): T | string {
    if (!allowed.includes(value as T)) {
      const expectedType = typeof allowed[0];
      this.add(path, typeof value === expectedType ? code : "INVALID_TYPE");
      return allowed[0] as T;
    }
    return value as T;
  }
  array(value: unknown, path: string, min: number, max = 100): unknown[] {
    if (!Array.isArray(value)) { this.add(path, "INVALID_TYPE"); return []; }
    if (value.length < min) this.add(path, "INVALID_VALUE");
    if (value.length > max) this.add(path, "LIMIT_EXCEEDED");
    return value.slice(0, max);
  }
  unique(values: readonly string[], paths: readonly string[], identity = false): void {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value)) this.add(paths[index] ?? "$", identity ? "DUPLICATE_IDENTITY" : "DUPLICATE_ID");
      seen.add(value);
    });
  }
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Obj)) freezeDeep(child);
  }
  return value;
}

function parseValue(input: unknown, v: Validator): TradingConfigurationV1 {
  const root = v.object(input, "$", ROOT_KEYS);
  const version = v.required(root, "schemaVersion", "$");
  if (typeof version !== "number") v.add("$.schemaVersion", "INVALID_TYPE");
  else if (version !== 1) v.add("$.schemaVersion", "UNSUPPORTED_VERSION");

  const instancesRaw = v.array(v.required(root, "strategyInstances", "$"), "$.strategyInstances", 0);
  const strategyInstances = instancesRaw.map((raw, i) => {
    const p = `$.strategyInstances[${i}]`;
    const o = v.object(raw, p, ["id", "implementationId", "revision", "enabled", "parameters"]);
    const id = v.id(v.required(o, "id", p), `${p}.id`);
    const impl = v.required(o, "implementationId", p);
    if (impl !== "momentum_breakout_long_v1") v.add(`${p}.implementationId`, "UNSUPPORTED_IMPLEMENTATION");
    const revision = v.number(v.required(o, "revision", p), `${p}.revision`, 1, Number.MAX_SAFE_INTEGER, true, true);
    const enabled = v.bool(v.required(o, "enabled", p), `${p}.enabled`);
    const rawParams = o && Object.hasOwn(o, "parameters") ? o.parameters : {};
    const params = v.object(rawParams, `${p}.parameters`, ["dailyReturn20MinPct", "h1Return4MinPct", "return60MinPct"]);
    const normalized = { ...MOMENTUM_CONFIGURATION_DEFAULTS_V1 } as MomentumConfigurationParametersV1;
    const bounds: Record<string, [number, number]> = { dailyReturn20MinPct: [0, 100], h1Return4MinPct: [0, 100], return60MinPct: [0, 3] };
    for (const [key, [min, max]] of Object.entries(bounds)) {
      if (params && Object.hasOwn(params, key)) (normalized as unknown as Obj)[key] = v.number(params[key], `${p}.parameters.${key}`, min, max);
    }
    return { id, implementationId: "momentum_breakout_long_v1" as const, revision, enabled, parameters: normalized };
  });
  v.unique(strategyInstances.map((x) => x.id), strategyInstances.map((_, i) => `$.strategyInstances[${i}].id`));

  const readPolicies = <T>(name: string, min: number, parse: (row: Obj | undefined, path: string) => T): T[] =>
    v.array(v.required(root, name, "$"), `$.${name}`, min).map((raw, i) => parse(v.object(raw, `$.${name}[${i}]`, policyKeys[name]!), `$.${name}[${i}]`));
  const byId = <T extends { id: string }>(rows: T[], path: string): T[] => {
    v.unique(rows.map((x) => x.id), rows.map((_, i) => `${path}[${i}].id`)); return rows;
  };
  const accountPolicies = byId(readPolicies("accountPolicies", 1, (o,p) => ({ id:v.id(v.required(o,"id",p),`${p}.id`), maxOpenPositions:v.literal(v.required(o,"maxOpenPositions",p),`${p}.maxOpenPositions`,[1]) as 1, accountDayTimeZone:v.literal(v.required(o,"accountDayTimeZone",p),`${p}.accountDayTimeZone`,["Europe/Warsaw"]) as "Europe/Warsaw" })), "$.accountPolicies");
  const entryPolicies = byId(readPolicies("entryPolicies", 1, (o,p) => ({ id:v.id(v.required(o,"id",p),`${p}.id`), kind:v.literal(v.required(o,"kind",p),`${p}.kind`,["supervised_one_attempt"]) as "supervised_one_attempt", maxAttemptsPerAccountDay:v.literal(v.required(o,"maxAttemptsPerAccountDay",p),`${p}.maxAttemptsPerAccountDay`,[1]) as 1 })), "$.entryPolicies");
  const executionPolicies = byId(readPolicies("executionPolicies", 1, (o,p) => ({ id:v.id(v.required(o,"id",p),`${p}.id`), direction:v.literal(v.required(o,"direction",p),`${p}.direction`,["LONG"]) as "LONG", quantity:v.literal(v.required(o,"quantity",p),`${p}.quantity`,[1]) as 1, quantityUnit:v.literal(v.required(o,"quantityUnit",p),`${p}.quantityUnit`,["shares"]) as "shares", orderType:v.literal(v.required(o,"orderType",p),`${p}.orderType`,["LMT"]) as "LMT", timeInForce:v.literal(v.required(o,"timeInForce",p),`${p}.timeInForce`,["DAY"]) as "DAY", outsideRth:v.literal(v.required(o,"outsideRth",p),`${p}.outsideRth`,[false]) as false, protection:v.literal(v.required(o,"protection",p),`${p}.protection`,["bracket"]) as "bracket" })), "$.executionPolicies");
  const riskPolicies = byId(readPolicies("riskPolicies", 1, (o,p) => {
    const n = v.object(v.required(o,"maxEntryNotional",p),`${p}.maxEntryNotional`,["amount","currency"]);
    return { id:v.id(v.required(o,"id",p),`${p}.id`), maxPositionQuantity:v.literal(v.required(o,"maxPositionQuantity",p),`${p}.maxPositionQuantity`,[1]) as 1, maxEntryNotional:{ amount:v.number(v.required(n,"amount",`${p}.maxEntryNotional`),`${p}.maxEntryNotional.amount`,Number.MIN_VALUE,1_000_000,false,true), currency:v.literal(v.required(n,"currency",`${p}.maxEntryNotional`),`${p}.maxEntryNotional.currency`,["PLN","USD"]) as "PLN"|"USD" }, maxSpread:v.number(v.required(o,"maxSpread",p),`${p}.maxSpread`,Number.MIN_VALUE,10_000,false,true), maxSlippage:v.number(v.required(o,"maxSlippage",p),`${p}.maxSlippage`,Number.MIN_VALUE,10_000,false,true), allowOvernight:v.literal(v.required(o,"allowOvernight",p),`${p}.allowOvernight`,[false]) as false };
  }), "$.riskPolicies");
  const researchPolicies = byId(readPolicies("researchPolicies", 1, (o,p) => ({ id:v.id(v.required(o,"id",p),`${p}.id`), required:v.literal(v.required(o,"required",p),`${p}.required`,[true]) as true, kind:v.literal(v.required(o,"kind",p),`${p}.kind`,["issuer_news_required_v1"]) as "issuer_news_required_v1" })), "$.researchPolicies");
  const issuerMappings = byId(readPolicies("issuerMappings", 1, (o,p) => ({ id:v.id(v.required(o,"id",p),`${p}.id`), issuerId:v.id(v.required(o,"issuerId",p),`${p}.issuerId`), providerSymbol:v.string(v.required(o,"providerSymbol",p),`${p}.providerSymbol`,SYMBOL,32), currency:v.literal(v.required(o,"currency",p),`${p}.currency`,["PLN","USD"]) as "PLN"|"USD", primaryExchange:v.literal(v.required(o,"primaryExchange",p),`${p}.primaryExchange`,[...VENUES]) as "WSE"|"NASDAQ"|"NYSE"|"AMEX" })), "$.issuerMappings");

  const instrumentsRaw = v.array(v.required(root, "instruments", "$"), "$.instruments", 1);
  const instruments = instrumentsRaw.map((raw, i) => {
    const p = `$.instruments[${i}]`;
    const o = v.object(raw, p, ["id","assetClass","contract","session","monitoringEnabled","entryEnabled","strategySelection","accountPolicyId","entryPolicyId","executionPolicyId","riskPolicyId","researchPolicyId","issuerMappingId"]);
    const contract = v.object(v.required(o,"contract",p),`${p}.contract`,["broker","symbol","conId","exchange","primaryExchange","currency","localSymbol","tradingClass","expectedMinTick"]);
    const session = v.object(v.required(o,"session",p),`${p}.session`,["useRTH","timeZone"]);
    const selection = v.object(v.required(o,"strategySelection",p),`${p}.strategySelection`,["mode","instanceIds"]);
    const exchange = v.literal(v.required(contract,"exchange",`${p}.contract`),`${p}.contract.exchange`,["WSE","SMART"]);
    const primary = v.literal(v.required(contract,"primaryExchange",`${p}.contract`),`${p}.contract.primaryExchange`,[...VENUES]);
    const currency = v.literal(v.required(contract,"currency",`${p}.contract`),`${p}.contract.currency`,["PLN","USD"]);
    const timezone = v.literal(v.required(session,"timeZone",`${p}.session`),`${p}.session.timeZone`,["Europe/Warsaw","America/New_York"]);
    if (exchange === "WSE" && (primary !== "WSE" || currency !== "PLN" || timezone !== "Europe/Warsaw")) v.add(`${p}.contract`,"UNSUPPORTED_CAPABILITY");
    if (exchange === "SMART" && (!(["NASDAQ","NYSE","AMEX"] as string[]).includes(primary) || currency !== "USD" || timezone !== "America/New_York")) v.add(`${p}.contract`,"UNSUPPORTED_CAPABILITY");
    const instanceIds = v.array(v.required(selection,"instanceIds",`${p}.strategySelection`),`${p}.strategySelection.instanceIds`,0).map((x,j)=>v.id(x,`${p}.strategySelection.instanceIds[${j}]`));
    v.unique(instanceIds, instanceIds.map((_,j)=>`${p}.strategySelection.instanceIds[${j}]`));
    const entryEnabled = v.bool(v.required(o,"entryEnabled",p),`${p}.entryEnabled`);
    const monitoringEnabled = v.bool(v.required(o,"monitoringEnabled",p),`${p}.monitoringEnabled`);
    const mode = v.literal(v.required(selection,"mode",`${p}.strategySelection`),`${p}.strategySelection.mode`,["single"]);
    if (mode === "single" && (entryEnabled ? instanceIds.length !== 1 : instanceIds.length > 1)) v.add(`${p}.strategySelection.instanceIds`,"INVALID_VALUE");
    if (entryEnabled && !monitoringEnabled) v.add(`${p}.entryEnabled`,"CONTRADICTORY_POLICY");
    if (instanceIds.some((id) => !strategyInstances.some((x) => x.id === id))) v.add(`${p}.strategySelection.instanceIds`,"MISSING_REFERENCE");
    const refs = ["accountPolicyId","entryPolicyId","executionPolicyId","riskPolicyId","researchPolicyId","issuerMappingId"] as const;
    const ref = Object.fromEntries(refs.map((k)=>[k,v.id(v.required(o,k,p),`${p}.${k}`)])) as Record<(typeof refs)[number],string>;
    const find = <T extends {id:string}>(rows:T[], id:string, key:string):T|undefined => { const matches=rows.filter((x)=>x.id===id); if(matches.length!==1){v.add(`${p}.${key}`,"MISSING_REFERENCE");return undefined;} return matches[0]; };
    find(accountPolicies,ref.accountPolicyId,"accountPolicyId");
    find(entryPolicies,ref.entryPolicyId,"entryPolicyId");
    find(executionPolicies,ref.executionPolicyId,"executionPolicyId");
    const risk=find(riskPolicies,ref.riskPolicyId,"riskPolicyId");
    find(researchPolicies,ref.researchPolicyId,"researchPolicyId");
    const mapping=find(issuerMappings,ref.issuerMappingId,"issuerMappingId");
    if (risk && risk.maxEntryNotional.currency !== currency) v.add(`${p}.riskPolicyId`,"CONTRADICTORY_POLICY");
    if (mapping && (mapping.currency !== currency || mapping.primaryExchange !== primary)) v.add(`${p}.issuerMappingId`,"CONTRADICTORY_POLICY");
    return { id:v.id(v.required(o,"id",p),`${p}.id`), assetClass:v.literal(v.required(o,"assetClass",p),`${p}.assetClass`,["stock"]), contract:{ broker:v.literal(v.required(contract,"broker",`${p}.contract`),`${p}.contract.broker`,["ibkr"]), symbol:v.string(v.required(contract,"symbol",`${p}.contract`),`${p}.contract.symbol`,SYMBOL,32), conId:v.number(v.required(contract,"conId",`${p}.contract`),`${p}.contract.conId`,1,Number.MAX_SAFE_INTEGER,true,true), exchange, primaryExchange:primary, currency, localSymbol:v.string(v.required(contract,"localSymbol",`${p}.contract`),`${p}.contract.localSymbol`,SYMBOL,32), tradingClass:v.string(v.required(contract,"tradingClass",`${p}.contract`),`${p}.contract.tradingClass`,SYMBOL,32), expectedMinTick:v.number(v.required(contract,"expectedMinTick",`${p}.contract`),`${p}.contract.expectedMinTick`,Number.MIN_VALUE,1000,false,true) }, session:{ useRTH:v.literal(v.required(session,"useRTH",`${p}.session`),`${p}.session.useRTH`,[true]), timeZone:timezone }, monitoringEnabled, entryEnabled, strategySelection:{mode:mode as "single",instanceIds}, ...ref };
  });
  v.unique(instruments.map((x)=>x.id),instruments.map((_,i)=>`$.instruments[${i}].id`));
  v.unique(instruments.map((x)=>x.contract.symbol),instruments.map((_,i)=>`$.instruments[${i}].contract.symbol`),true);
  v.unique(instruments.map((x)=>`${x.contract.broker}:${x.contract.conId}`),instruments.map((_,i)=>`$.instruments[${i}].contract.conId`),true);
  v.unique(instruments.map((x)=>`${x.contract.broker}:${x.contract.primaryExchange}:${x.contract.currency}:${x.contract.symbol}`),instruments.map((_,i)=>`$.instruments[${i}].contract`),true);
  return { schemaVersion:1, strategyInstances, instruments, accountPolicies, entryPolicies, executionPolicies, riskPolicies, researchPolicies, issuerMappings } as TradingConfigurationV1;
}

const policyKeys: Record<string, readonly string[]> = {
  accountPolicies:["id","maxOpenPositions","accountDayTimeZone"],
  entryPolicies:["id","kind","maxAttemptsPerAccountDay"],
  executionPolicies:["id","direction","quantity","quantityUnit","orderType","timeInForce","outsideRth","protection"],
  riskPolicies:["id","maxPositionQuantity","maxEntryNotional","maxSpread","maxSlippage","allowOvernight"],
  researchPolicies:["id","required","kind"], issuerMappings:["id","issuerId","providerSymbol","currency","primaryExchange"],
};

export function parseTradingConfiguration(input: unknown): TradingConfigurationParseResult {
  let value = input;
  if (typeof input === "string") {
    if (new TextEncoder().encode(input).byteLength > MAX_JSON_BYTES) return { ok:false, issues:[{path:"$",code:"LIMIT_EXCEEDED",message:FIELD_MESSAGES.LIMIT_EXCEEDED}] };
    try { value = JSON.parse(input) as unknown; }
    catch { return { ok:false, issues:[{path:"$",code:"INVALID_JSON",message:FIELD_MESSAGES.INVALID_JSON}] }; }
  }
  const validator = new Validator();
  const configuration = parseValue(value, validator);
  if (validator.issues.length) return { ok:false, issues:validator.issues };
  return { ok:true, configuration:freezeDeep(configuration) };
}
