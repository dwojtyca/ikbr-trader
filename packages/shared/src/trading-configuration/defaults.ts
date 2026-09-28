import type { MomentumConfigurationParametersV1 } from "./types.js";

export const MOMENTUM_CONFIGURATION_DEFAULTS_V1: Readonly<MomentumConfigurationParametersV1> = Object.freeze({
  dailyReturn20MinPct: 8,
  h1Return4MinPct: 1,
  return20MaxPct: 1.2,
  return60MinPct: 0.2,
  return60MaxPct: 3,
  consolidationDriftMaxPct: 0.8,
  rsiMax: 72,
  bbWidthMaxPct: 0.08,
  volumeMultiplier: 1.2,
  closeLocationMin: 0.6,
  bodyMin: 0.12,
  upperWickMax: 0.45,
  plannedRewardMinPct: 0.6,
  stopAtrMult: 2,
  structureStopAtrMult: 3,
  takeProfitR: 5,
  minRegimeScore: 5,
  sessionUtcStartHour: 8,
  sessionUtcEndHour: 20,
});
