# Strategy Documentation

This document describes the strategies currently implemented in `apps/signal-engine/src/strategies`.

The default bot/backtest strategy set is controlled by `packages/shared/src/strategy-profiles.ts`.

## Current Strategy Set

Active by default:

- `momentum_breakout_long_v1`
- `momentum_breakdown_short_v1`
- `range_reversal_v1`

Implemented but disabled in the default bot/backtest portfolio:

- `failed_bounce_short_v1`

`failed_bounce_short_v1` remains available for strategy lab / isolated strategy testing through `listAllStrategyProfiles()`.

## Market Context Model

Strategies no longer use a single composite `regime`.

The signal engine classifies market context with two independent dimensions:

```text
directionalRegime:
  bull_trend
  bear_trend
  range

volatilityRegime:
  low_volatility
  normal_volatility
  high_volatility
```

`directionalRegime` is multi-timeframe. It scores:

- `1m`
- `5m`
- `1h`
- `4h`
- `12h`
- `1d`
- `1w`

It uses:

- trend label from EMA20/EMA50 and close vs EMA50
- close vs EMA50
- EMA20 vs EMA50
- close vs EMA200
- MACD histogram sign
- return20Pct

Higher timeframes have larger weights. `1h`, `4h`, `1d`, and `1w` are treated as major confirmation timeframes.

`volatilityRegime` is multi-timeframe and uses weighted samples from:

```text
1m weight 0.25
1h weight 0.25
4h weight 0.30
1d weight 0.20
```

It uses:

- ATR14 divided by close
- Bollinger Band width percentage

This prevents one isolated `1m` spike from immediately classifying the whole symbol as `high_volatility`.

## Indicators

The signal engine calculates indicators in `apps/signal-engine/src/indicators.ts`.

The project uses `indicatorts` for:

- EMA
- SMA
- RSI
- ATR
- MACD
- Bollinger Bands
- Donchian Channel
- CMF
- MFI
- OBV

ADX is implemented manually in the signal engine.

The main 1m indicator snapshot includes:

- EMA20, EMA50, EMA200, SMA200
- RSI14 and previous RSI14
- ATR14
- ADX14
- MACD line, signal, histogram, previous histograms
- CMF20 and previous CMF20
- MFI14 and previous MFI14
- Bollinger Bands and BB width
- Donchian upper/lower 20
- OBV slope
- 5m/20m/60m returns
- multi-timeframe snapshots for `5m`, `1h`, `4h`, `12h`, `1d`, `1w`

Each higher timeframe snapshot includes:

- close
- EMA20, EMA50, EMA200, SMA200
- RSI14
- ATR14
- ADX14
- MACD histogram and previous histograms
- CMF20
- MFI14
- BB width
- volume
- trend label
- price vs EMA50
- EMA50 slope over 10 candles
- returns over several lookbacks

---

# momentum_breakout_long_v1

## Status

Active in bot/backtest by default.

```text
enabledInBot = true
```

## Purpose

Long-only breakout strategy for bullish trend continuation.

The hypothesis:

```text
Strong instruments in a confirmed bull trend often continue higher after a short consolidation and a confirmed breakout through the recent 20-candle high.
```

This strategy should not trade low-volatility sideways markets. It expects trend alignment, enough momentum, and a real breakout candle.

## Supported Instruments

```text
secTypes:
  STK
  IND
```

## Supported Direction

```text
LONG only
side = BUY
```

## Required Market Context

```text
directionalRegime:
  bull_trend

volatilityRegime:
  normal_volatility
  high_volatility
```

Rejects:

```text
directionalRegime != bull_trend
volatilityRegime == low_volatility
```

## Required Timeframes

```text
1m
1h
4h
1d
```

## Core Conditions

Required current snapshot indicators:

- EMA20
- EMA50
- EMA200
- RSI14
- ATR14
- Donchian upper 20

Trend alignment:

```text
close > EMA200
close > EMA50
EMA20 > EMA50
```

Higher timeframe filters:

```text
1h trend must not be bearish
4h trend must not be bearish
1d trend must not be bearish
D1 return20Pct >= 8
H1 return4Pct >= 1
```

Momentum/overextension filters:

```text
RSI14 < 72
return20mPct <= 1.2
return60mPct <= 3
return60mPct >= 0.2
```

Volatility filter:

```text
bbWidthPct <= 0.08
```

This means the strategy wants a breakout after controlled compression, not after a very wide/chaotic move.

## Entry Logic

The strategy requires a confirmed breakout above the previous 20-candle high.

```text
priorHigh20 = max(high over previous 20 candles excluding current)
breakoutBuffer = max(ATR14 * 0.015, close * 0.00025)

valid breakout:
  close >= priorHigh20 + breakoutBuffer
```

It also rejects cases where the consolidation drift was already too strong:

```text
preBreakoutDriftPct <= 0.8
```

This avoids buying after the move has already happened before the breakout candle.

## Volume Filter

```text
averageVolume = average volume over previous 20 1m candles
latestVolume >= averageVolume * 0.95
```

## Breakout Candle Quality

The current candle must be a bullish breakout candle:

```text
close > open
closeLocationPct >= 0.60
bodyPct >= 0.12
upperWickPct <= 0.45
```

Meaning:

- close should be near the high,
- candle body should not be tiny,
- upper wick should not show strong rejection.

## Stop Loss

The stop combines ATR and recent consolidation structure:

```text
atrStop = close - ATR14 * 2
structureStop = max(consolidationLow20, close - ATR14 * 3)
stopLoss = min(atrStop, structureStop)
```

The stop must be below entry.

## Take Profit

```text
riskPerShare = close - stopLoss
takeProfit = close + riskPerShare * 4
```

Minimum planned reward:

```text
plannedRewardPct >= 0.6
```

## Scoring

Base confidence:

```text
0.58
```

Additive components:

- trend score from EMA20 - EMA50 distance
- breakout score from close - priorHigh20 distance
- RSI score if RSI is strong but not overheated
- compression score from BB width

Final confidence is clamped:

```text
0.58 <= confidenceScore <= 0.88
```

## Typical Rejection Reasons

- `directional_regime_not_bull_trend`
- `volatility_regime_low_volatility`
- `higher_timeframe_1h_bearish`
- `higher_timeframe_4h_bearish`
- `higher_timeframe_1d_bearish`
- `daily_momentum_too_weak`
- `hourly_momentum_too_weak`
- `close_below_ema200`
- `close_below_ema50`
- `ema20_not_above_ema50`
- `rsi_overheated`
- `overextended_20m`
- `overextended_60m`
- `intraday_momentum_too_weak`
- `volatility_not_compressed`
- `no_confirmed_breakout`
- `pre_breakout_drift_too_high`
- `volume_not_confirmed`
- `breakout_candle_not_bullish`
- `breakout_close_not_near_high`
- `breakout_body_too_small`
- `breakout_upper_wick_too_large`

---

# momentum_breakdown_short_v1

## Status

Active in bot/backtest by default.

```text
enabledInBot = true
```

## Purpose

Short-only breakdown strategy for bearish trend continuation.

The hypothesis:

```text
Weak instruments in a confirmed bear trend often continue lower after a short consolidation and a confirmed breakdown through the recent 20-candle low.
```

It is the directional inverse of `momentum_breakout_long_v1`, but with additional guardrails to avoid shorting too late into an already extended selloff.

## Supported Instruments

```text
secTypes:
  STK
  IND
```

## Supported Direction

```text
SHORT only
side = SELL
```

## Required Market Context

```text
directionalRegime:
  bear_trend

volatilityRegime:
  normal_volatility
  high_volatility
```

Rejects:

```text
directionalRegime != bear_trend
volatilityRegime == low_volatility
```

## Required Timeframes

```text
1m
1h
4h
1d
```

## Core Conditions

Required current snapshot indicators:

- EMA20
- EMA50
- EMA200
- RSI14
- ATR14
- Donchian lower 20

Trend alignment:

```text
close < EMA200
close < EMA50
EMA20 < EMA50
```

Higher timeframe filters:

```text
1h trend must not be bullish
4h trend must not be bullish
1d trend must not be bullish
H4 RSI14 <= 38
D1 return20Pct <= -8
H1 return4Pct <= -1
```

Distance filters:

```text
distance below EMA20 <= 1.5%
distance below EMA50 <= 5%
```

These filters prevent late shorts after a large move away from the moving averages.

Momentum/overextension filters:

```text
RSI14 > 28
return20mPct >= -1.2
return60mPct >= -3
return60mPct <= -0.2
```

Volatility filter:

```text
bbWidthPct <= 0.08
```

## Entry Logic

The strategy requires a confirmed breakdown below the previous 20-candle low.

```text
priorLow20 = min(low over previous 20 candles excluding current)
breakdownBuffer = max(ATR14 * 0.015, close * 0.00025)

valid breakdown:
  close <= priorLow20 - breakdownBuffer
```

It also rejects cases where the pre-breakdown drift was already too negative:

```text
preBreakdownDriftPct >= -0.8
```

This avoids shorting a move that has already broken down before the confirmation candle.

## Volume Filter

```text
averageVolume = average volume over previous 20 1m candles
latestVolume >= averageVolume * 0.95
```

## Breakdown Candle Quality

The current candle must be a bearish breakdown candle:

```text
close < open
closeLocationPct >= 0.60
bodyPct >= 0.12
lowerWickPct <= 0.45
```

For shorts, `closeLocationPct` is calculated as distance from high to close divided by candle range, so higher value means close near the low.

## Stop Loss

The stop combines ATR and recent consolidation structure:

```text
atrStop = close + ATR14 * 1.5
structureStop = min(consolidationHigh20, close + ATR14 * 2.5)
stopLoss = max(atrStop, structureStop)
```

The stop must be above entry.

## Take Profit

```text
riskPerShare = stopLoss - close
takeProfit = close - riskPerShare * 3
```

Minimum planned reward:

```text
plannedRewardPct >= 0.6
```

## Scoring

Base confidence:

```text
0.58
```

Additive components:

- trend score from EMA50 - EMA20 distance
- breakdown score from priorLow20 - close distance
- RSI score if RSI is weak but not oversold
- compression score from BB width

Final confidence is clamped:

```text
0.58 <= confidenceScore <= 0.88
```

## Typical Rejection Reasons

- `directional_regime_not_bear_trend`
- `volatility_regime_low_volatility`
- `higher_timeframe_1h_bullish`
- `higher_timeframe_4h_bullish`
- `higher_timeframe_1d_bullish`
- `h4_rsi_too_high`
- `daily_momentum_too_weak`
- `hourly_momentum_too_weak`
- `close_above_ema200`
- `close_above_ema50`
- `ema20_not_below_ema50`
- `too_far_below_ema20`
- `too_far_below_ema50`
- `rsi_oversold`
- `overextended_20m`
- `overextended_60m`
- `intraday_momentum_too_weak`
- `volatility_not_compressed`
- `no_confirmed_breakdown`
- `pre_breakdown_drift_too_low`
- `volume_not_confirmed`
- `breakdown_candle_not_bearish`
- `breakdown_close_not_near_low`
- `breakdown_body_too_small`
- `breakdown_lower_wick_too_large`

---

# range_reversal_v1

## Status

Active in bot/backtest by default.

```text
enabledInBot = true
```

## Purpose

Two-sided mean-reversion strategy for range markets with normal or elevated volatility.

The hypothesis:

```text
In a non-trending market, price often rejects the upper/lower edge of a defined range and rotates back toward the middle.
```

This strategy is not designed for low volatility compression. It should trade only when the range is wide enough to provide practical reward/risk.

## Supported Instruments

```text
secTypes:
  STK
  IND
  ETF
  CMDTY
  FUT
```

## Supported Direction

```text
LONG and SHORT
BUY near lower range edge
SELL near upper range edge
```

## Required Market Context

```text
directionalRegime:
  range

volatilityRegime:
  normal_volatility
  high_volatility
```

Rejects:

```text
directionalRegime != range
volatilityRegime == low_volatility
```

## Required Timeframes

```text
1m
1h
4h
```

The implementation primarily uses the 1m execution context plus the regime detector's multi-timeframe classification.

## Core Indicators

Required:

- ATR14
- RSI14
- Bollinger upper/middle/lower
- Donchian upper/lower 20

Optional but used as filters when available:

- CMF20
- MFI14

## Range Definition

The current range is approximated with Donchian 20:

```text
rangeLow = dcLower20
rangeHigh = dcUpper20
rangeWidthPct = (rangeHigh - rangeLow) / close * 100
```

Valid range width:

```text
rangeWidthPct >= 0.45
rangeWidthPct <= 8
```

This avoids:

- ranges too narrow to pay spread/commission/slippage,
- ranges so wide they may represent unstable repricing instead of controlled rotation.

## Volume Filter

```text
averageVolume = average volume over previous 20 1m candles
latestVolume >= averageVolume * 0.8
```

## Long Setup

The long setup looks for rejection near the lower edge.

Edge proximity:

```text
edgeDistance = min(abs(close - bbLower), abs(close - dcLower20))
edgeThreshold = max(ATR14 * 0.45, close * 0.25%)

valid:
  edgeDistance <= edgeThreshold
```

Momentum:

```text
RSI14 <= 42
```

Candle rejection:

```text
close > open
closeLocationPct >= 0.58
bodyPct >= 0.08
lowerWickPct >= 0.18
```

Money flow guards:

```text
reject if CMF20 < -0.2
reject if MFI14 < 18
```

These avoid buying a lower-edge touch when selling pressure remains extreme.

## Short Setup

The short setup looks for rejection near the upper edge.

Edge proximity:

```text
edgeDistance = min(abs(close - bbUpper), abs(close - dcUpper20))
edgeThreshold = max(ATR14 * 0.45, close * 0.25%)

valid:
  edgeDistance <= edgeThreshold
```

Momentum:

```text
RSI14 >= 58
```

Candle rejection:

```text
close < open
close near lower part of candle range
bodyPct >= 0.08
upperWickPct >= 0.18
```

Money flow guards:

```text
reject if CMF20 > 0.2
reject if MFI14 > 82
```

These avoid shorting an upper-edge touch when buying pressure remains extreme.

## Long Stop Loss

```text
atrStop = close - ATR14 * 1.25
structureStop = max(swingLow20, close - ATR14 * 2.2)
stopLoss = min(atrStop, structureStop)
```

## Short Stop Loss

```text
atrStop = close + ATR14 * 1.25
structureStop = min(swingHigh20, close + ATR14 * 2.2)
stopLoss = max(atrStop, structureStop)
```

## Take Profit

For long:

```text
takeProfit = min(Bollinger middle, close + 0.5 * Donchian range width)
```

For short:

```text
takeProfit = max(Bollinger middle, close - 0.5 * Donchian range width)
```

The strategy targets the middle of the range, not a full range rotation. This is deliberate: mean reversion edge usually degrades when waiting for the opposite edge.

## Minimum Reward/Risk

Normal volatility:

```text
rewardRisk >= 0.9
```

High volatility:

```text
rewardRisk >= 1.1
```

High volatility requires a better reward/risk because stop-outs and slippage are more likely.

## Scoring

Base confidence:

```text
0.58
```

Additive components:

- edge proximity score
- RSI stretch score
- rejection candle score
- wick quality score

Final confidence is clamped:

```text
0.58 <= confidenceScore <= 0.84
```

## Typical Rejection Reasons

- `directional_regime_not_range`
- `volatility_regime_low_volatility`
- `missing_required_indicators`
- `invalid_price_or_atr`
- `range_too_narrow`
- `range_too_wide`
- `volume_baseline_unavailable`
- `volume_not_confirmed`
- `no_range_reversal_setup`

---

# failed_bounce_short_v1

## Status

Implemented but disabled in the default bot/backtest portfolio.

```text
enabledInBot = false
```

Available for strategy lab / isolated testing.

## Purpose

Short-only failed-bounce strategy.

The hypothesis:

```text
In a confirmed bear trend, short-term relief bounces into resistance often fail and continue lower.
```

Unlike `momentum_breakdown_short_v1`, this strategy does not short a fresh breakdown immediately. It waits for:

```text
bear trend -> bounce into resistance -> rejection candle -> trigger below setup low
```

It uses a stop-entry style signal:

```text
entryOrderType = STP
```

## Supported Instruments

```text
secTypes:
  STK
  IND
  ETF
  CMDTY
  FUT
```

## Supported Direction

```text
SHORT only
side = SELL
```

## Required Market Context

```text
directionalRegime:
  bear_trend

volatilityRegime:
  normal_volatility
  high_volatility
```

Rejects:

```text
directionalRegime != bear_trend
volatilityRegime == low_volatility
```

## Required Timeframes

```text
1m
1h
4h
1d
```

## Core Indicators

Required current snapshot indicators:

- EMA20
- EMA50
- EMA200
- SMA200
- RSI14 and previous RSI14
- ATR14
- MACD histogram and previous two histogram values
- CMF20
- MFI14

Required daily indicators:

- D1 close
- D1 EMA20
- D1 EMA50
- D1 SMA200
- D1 ADX14
- D1 EMA50 slope over 10 candles

## Bear Trend Filter

Daily trend must be bearish:

```text
D1 close < D1 SMA200
D1 close < D1 EMA50
D1 EMA20 < D1 EMA50
D1 EMA50 slope10Pct < 0
D1 ADX14 >= 22
```

Higher timeframe filters:

```text
1h trend must not be bullish
4h trend must not be bullish
1d trend must not be bullish
H4 RSI14 <= 48
D1 return20Pct <= -5
H1 return4Pct <= 1
```

Current snapshot alignment:

```text
close < EMA200
close < EMA50
EMA20 < EMA50
close < EMA20 after rejection
distance below EMA20 <= 1.2%
```

## Momentum Filters

RSI:

```text
30 < RSI14 < 50
RSI14 < 50
```

MACD histogram:

```text
macdHist < macdHistPrev < macdHistPrev2
```

This requires weakening momentum over two bars.

Intraday return filters:

```text
return20mPct >= -1.4
return20mPct <= 1.2
return60mPct >= -2.5
return60mPct <= 2
```

These avoid both:

- shorting too late after an extended selloff,
- shorting a bounce that remains too strong.

## Money Flow Filters

Hard rejects:

```text
CMF20 > 0.08
MFI14 > 65
```

Scoring improves when:

```text
CMF20 < 0
MFI14 < previous MFI14
OBV slope < 0
```

## Volatility Filter

```text
bbWidthPct <= 0.10
```

This avoids chaotic repricing where failed-bounce structure is less reliable.

## Resistance Retest

The setup candle must touch at least one resistance zone:

```text
EMA20/EMA50 resistance
prior support retested from below
Bollinger middle/upper band
```

Tolerance:

```text
resistanceTolerancePct = 0.35
```

## Setup Candle

The setup candle is the candle before the trigger candle.

Required:

```text
setup close rejects highs
setup upper wick >= 0.12
```

## Trigger Candle

The current candle must confirm failure:

```text
trigger close < setup candle low
trigger candle bearish
close near low
bodyPct >= 0.10
upperWickPct >= 0.12
```

## Entry

The strategy emits a stop entry below the trigger candle:

```text
triggerBuffer = max(ATR14 * 0.05, close * 3 bps)
entryStop = triggerCandle.low - triggerBuffer
```

## Liquidity Filters

```text
averageVolume20 >= 1,000
averageVolume20 * close >= 50,000
latestVolume >= averageVolume20 * 0.8
```

## Stop Loss

```text
rejectionBuffer = max(ATR14 * 0.1, entryStop * 0.0005)
atrStop = entryStop + ATR14 * 1.6
structureStop = rejectionHigh + rejectionBuffer
stopLoss = max(atrStop, structureStop)
maxStop = entryStop + ATR14 * 2.6
```

Reject if:

```text
stopLoss <= entryStop
stopLoss > maxStop
```

## Take Profit

```text
riskPerShare = stopLoss - entryStop
tp1 = entryStop - riskPerShare * 1
takeProfit = entryStop - riskPerShare * 2.5
```

Metadata includes:

```text
breakevenAfterTp1 = true
trailingPlan = future: after TP1, trail remaining size by EMA20 or ATR
```

The current execution/backtest layer still uses the single `takeProfit` field; partial TP and trailing are documented in metadata for future execution support.

## Scoring

Minimum score:

```text
minScore = 7
```

Score components:

- daily bear trend
- daily EMA alignment
- falling D1 EMA50
- D1 ADX trend strength
- intraday EMA alignment
- resistance retest quality
- confirmed break below setup low
- close back below EMA20
- bearish rejection quality
- RSI rolling over
- MACD weakening
- bearish money flow
- MFI weakening
- OBV weakening

Confidence:

```text
confidenceScore = clamp(0.5 + signalScore / 20, 0, 0.88)
```

## Typical Rejection Reasons

- `directional_regime_not_bear_trend`
- `volatility_regime_low_volatility`
- `daily_trend_indicators_unavailable`
- `higher_timeframe_1h_bullish`
- `higher_timeframe_4h_bullish`
- `higher_timeframe_1d_bullish`
- `h4_rsi_too_high`
- `daily_momentum_too_weak`
- `hourly_bounce_too_strong`
- `daily_close_above_sma200`
- `daily_close_above_ema50`
- `daily_ema20_not_below_ema50`
- `daily_ema50_not_falling`
- `daily_adx_too_low`
- `close_above_ema200`
- `close_above_ema50`
- `ema20_not_below_ema50`
- `close_not_back_below_ema20`
- `too_far_below_ema20`
- `rsi_oversold`
- `rsi_too_strong`
- `money_flow_too_positive`
- `mfi_too_strong`
- `macd_hist_not_falling_two_bars`
- `overextended_20m`
- `bounce_too_strong_20m`
- `overextended_60m`
- `bounce_too_strong_60m`
- `volatility_too_wide`
- `not_enough_1m_candles`
- `no_resistance_retest`
- `trigger_close_not_below_setup_low`
- `average_volume_too_low`
- `average_notional_too_low`
- `volume_not_confirmed`
- `rejection_candle_not_bearish`
- `rejection_close_not_near_low`
- `rejection_body_too_small`
- `rejection_upper_wick_too_small`
- `stop_too_wide`
- `score_too_low`

---

# Portfolio Notes

The portfolio manager runs all active strategy implementations and selects the highest-confidence valid signal.

Current default active portfolio:

```text
momentum_breakout_long_v1:
  bull_trend + normal/high volatility

momentum_breakdown_short_v1:
  bear_trend + normal/high volatility

range_reversal_v1:
  range + normal/high volatility
```

Disabled but implemented:

```text
failed_bounce_short_v1:
  bear_trend + normal/high volatility
```

No implemented strategy currently targets:

```text
range + low_volatility
bull_trend + low_volatility
bear_trend + low_volatility
```

Those should be separate strategies, not relaxed versions of the existing momentum/reversal logic.
