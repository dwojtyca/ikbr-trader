export interface MomentumConfigurationParametersV1 {
  readonly dailyReturn20MinPct: number;
  readonly h1Return4MinPct: number;
  readonly return20MaxPct: number;
  readonly return60MinPct: number;
  readonly return60MaxPct: number;
  readonly consolidationDriftMaxPct: number;
  readonly rsiMax: number;
  readonly bbWidthMaxPct: number;
  readonly volumeMultiplier: number;
  readonly closeLocationMin: number;
  readonly bodyMin: number;
  readonly upperWickMax: number;
  readonly plannedRewardMinPct: number;
  readonly stopAtrMult: number;
  readonly structureStopAtrMult: number;
  readonly takeProfitR: number;
  readonly minRegimeScore: number;
  readonly sessionUtcStartHour: number;
  readonly sessionUtcEndHour: number;
}

export interface TradingStrategyInstanceV1 {
  readonly id: string;
  readonly implementationId: "momentum_breakout_long_v1";
  readonly revision: number;
  readonly enabled: boolean;
  readonly parameters: MomentumConfigurationParametersV1;
}

export interface TradingAccountPolicyV1 {
  readonly id: string;
  readonly maxOpenPositions: 1;
  readonly accountDayTimeZone: "Europe/Warsaw";
}

export interface TradingEntryPolicyV1 {
  readonly id: string;
  readonly kind: "supervised_one_attempt" | "bounded_scheduled";
  readonly maxAttemptsPerAccountDay: 1 | 2;
}

export interface TradingExecutionPolicyV1 {
  readonly id: string;
  readonly direction: "LONG";
  readonly quantity: 1;
  readonly quantityUnit: "shares";
  readonly orderType: "LMT";
  readonly timeInForce: "DAY";
  readonly outsideRth: false;
  readonly protection: "bracket";
}

export interface TradingRiskPolicyV1 {
  readonly id: string;
  readonly maxPositionQuantity: 1;
  readonly maxEntryNotional: { readonly amount: number; readonly currency: "PLN" | "USD" };
  readonly maxSpread: number;
  readonly maxSlippage: number;
  readonly allowOvernight: false;
}

export interface TradingResearchPolicyV1 {
  readonly id: string;
  readonly required: true;
  readonly kind: "issuer_news_required_v1";
}

export interface TradingIssuerMappingV1 {
  readonly id: string;
  readonly issuerId: string;
  readonly providerSymbol: string;
  readonly currency: "PLN" | "USD";
  readonly primaryExchange: "WSE" | "NASDAQ" | "NYSE" | "AMEX";
}

export interface TradingInstrumentV1 {
  readonly id: string;
  readonly assetClass: "stock";
  readonly contract: {
    readonly broker: "ibkr";
    readonly symbol: string;
    readonly conId: number;
    readonly exchange: "WSE" | "SMART";
    readonly primaryExchange: "WSE" | "NASDAQ" | "NYSE" | "AMEX";
    readonly currency: "PLN" | "USD";
    readonly localSymbol: string;
    readonly tradingClass: string;
    readonly expectedMinTick: number;
  };
  readonly session: { readonly useRTH: true; readonly timeZone: "Europe/Warsaw" | "America/New_York" };
  readonly monitoringEnabled: boolean;
  readonly entryEnabled: boolean;
  readonly strategySelection: { readonly mode: "single"; readonly instanceIds: readonly string[] } | { readonly mode: "priority"; readonly instanceIds: readonly string[]; readonly priorities: Readonly<Record<string, number>> };
  readonly accountPolicyId: string;
  readonly entryPolicyId: string;
  readonly executionPolicyId: string;
  readonly riskPolicyId: string;
  readonly researchPolicyId: string;
  readonly issuerMappingId: string;
}

export interface TradingConfigurationV1 {
  readonly schemaVersion: 1;
  readonly strategyInstances: readonly TradingStrategyInstanceV1[];
  readonly instruments: readonly TradingInstrumentV1[];
  readonly accountPolicies: readonly TradingAccountPolicyV1[];
  readonly entryPolicies: readonly TradingEntryPolicyV1[];
  readonly executionPolicies: readonly TradingExecutionPolicyV1[];
  readonly riskPolicies: readonly TradingRiskPolicyV1[];
  readonly researchPolicies: readonly TradingResearchPolicyV1[];
  readonly issuerMappings: readonly TradingIssuerMappingV1[];
}

export interface TradingConfigurationIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export type TradingConfigurationParseResult =
  | { readonly ok: true; readonly configuration: TradingConfigurationV1 }
  | { readonly ok: false; readonly issues: readonly TradingConfigurationIssue[] };
