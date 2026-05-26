# Strategy Documentation

This document describes the strategies currently implemented in `apps/signal-engine/src/strategies`.

The default bot/backtest strategy set is driven by `packages/shared/src/strategy-profiles.ts`.
The actual executable strategy implementations are registered in `apps/signal-engine/src/strategies/strategy-registry.ts`.

## Current Strategy Set

Active by default:

- `momentum_breakout_long_v1`
- `momentum_breakdown_short_v1`
- `gap_fade_short_v1`

Implemented but disabled in the default bot/backtest portfolio:

- `range_reversal_v1`
- `trend_following_long_v1`

Removed:

- `failed_bounce_short_v1`

Disabled strategies remain available through the registry and can be tested in isolated / strategy-lab workflows, but they are not part of the default bot portfolio.

## Market Context Model

Strategies use two independent market-context dimensions:

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

`directionalRegime` is calculated from multiple timeframes:

```text
1m, 5m, 1h, 4h, 12h, 1d, 1w
```

It scores:

- trend label from close/EMA20/EMA50 alignment,
- close vs EMA50,
- EMA20 vs EMA50,
- close vs EMA200,
- MACD histogram sign,
- return20Pct.

Higher timeframes carry larger weights. `1h`, `4h`, `1d`, and `1w` are treated as major confirmation timeframes.

`volatilityRegime` is calculated from weighted volatility samples:

```text
1m weight 0.25
1h weight 0.25
4h weight 0.30
1d weight 0.20
```

It uses:

- ATR14 / close,
- Bollinger Band width percentage.

This avoids classifying the entire symbol as `high_volatility` from a single 1m spike when higher timeframes remain normal.

## Indicator Sources

The signal engine calculates indicators in `apps/signal-engine/src/indicators.ts`.

`indicatorts` is used for:

- EMA,
- SMA,
- RSI,
- ATR,
- MACD,
- Bollinger Bands,
- Donchian Channel,
- CMF,
- MFI,
- OBV.

ADX is implemented manually.

The main 1m `IndicatorSnapshot` includes:

- EMA20, EMA50, EMA200, SMA200,
- RSI14 and previous RSI14,
- ATR14,
- ADX14,
- MACD line/signal/histogram and previous histograms,
- CMF20 and previous CMF20,
- MFI14 and previous MFI14,
- Bollinger Bands and BB width,
- Donchian upper/lower 20,
- OBV slope,
- return5mPct, return20mPct, return60mPct,
- intraday session metadata,
- higher-timeframe snapshots for `5m`, `1h`, `4h`, `12h`, `1d`, `1w`.

The higher-timeframe snapshots include:

- close,
- EMA20, EMA50, EMA200, SMA200,
- RSI14,
- ATR14,
- ADX14,
- MACD histogram and previous histograms,
- CMF20,
- MFI14,
- BB width,
- volume,
- trend label,
- price vs EMA50,
- EMA50 slope over 10 candles,
- several return lookbacks.

## Intraday Session Metadata

`SignalEngine` derives intraday metadata from 1m candles by detecting the latest inter-candle time gap greater than the session-gap threshold.

The snapshot includes:

- previous session close,
- current session open,
- current session open timestamp,
- minutes since session open,
- overnight gap percent,
- 30-minute opening range high/low,
- session VWAP,
- distance from VWAP in basis points,
- cumulative session volume.

This metadata is required by `gap_fade_short_v1`.

---

# momentum_breakout_long_v1

## Status

Active in bot/backtest by default.

```text
enabledInBot = true
```

## Purpose

Long-only momentum continuation strategy.

Hypothesis:

```text
Instruments in a confirmed bull trend can continue higher after short consolidation and a confirmed breakout through the recent 20-candle high.
```

## Supported Instruments

Implementation currently accepts:

```text
STK
IND
```

The shared profile currently lists broader secTypes, but the strategy implementation still rejects anything other than `STK` and `IND`.

## Direction

```text
LONG only
side = BUY
```

## Required Market Context

```text
directionalRegime = bull_trend
volatilityRegime = normal_volatility | high_volatility
```

Hard rejects:

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

## Core Filters

Required indicators:

- EMA20,
- EMA50,
- EMA200,
- RSI14,
- ATR14,
- Donchian upper 20.

Current timeframe alignment:

```text
close > EMA200
close > EMA50
EMA20 > EMA50
RSI14 < 72
```

Higher timeframe alignment:

```text
1h trend must not be bearish
4h trend must not be bearish
1d trend must not be bearish
D1 return20Pct >= 8
H1 return4Pct >= 1
```

Intraday momentum filters:

```text
return20mPct <= 1.2
return60mPct >= 0.2
return60mPct <= 3
```

Volatility/compression filter:

```text
bbWidthPct <= 0.08
```

## Entry Logic

The strategy confirms a breakout above the previous 20-candle high.

```text
priorHigh20 = max(high over previous 20 candles excluding current)
breakoutBuffer = max(ATR14 * 0.015, close * 0.00025)
validBreakout = close >= priorHigh20 + breakoutBuffer
```

It also checks pre-breakout drift:

```text
preBreakoutDriftPct <= 0.8
```

This avoids buying a move that already ran before the breakout candle.

## Volume Filter

```text
previousAverageVolume = average previous 20 1m candles
latestVolume >= previousAverageVolume * 0.95
```

## Candle Quality

The breakout candle must be bullish and close with good quality:

```text
close > open
closeLocationPct >= 0.60
bodyPct >= 0.12
upperWickPct <= 0.45
```

## Stop Loss

```text
atrStop = close - ATR14 * 2
structureStop = max(localConsolidationLow20, close - ATR14 * 3)
stopLoss = min(atrStop, structureStop)
```

## Take Profit

```text
riskPerShare = close - stopLoss
takeProfit = close + riskPerShare * 4
plannedRewardPct >= 0.6
```

## Scoring

Base confidence:

```text
0.58
```

Additive components:

- EMA trend strength,
- breakout distance,
- RSI strength without overheating,
- Bollinger compression.

Confidence is clamped to:

```text
0.58 - 0.88
```

---

# momentum_breakdown_short_v1

## Status

Active in bot/backtest by default.

```text
enabledInBot = true
```

## Purpose

Short-only bearish momentum continuation strategy.

Hypothesis:

```text
Weak instruments in a confirmed bear trend can continue lower after short consolidation and a confirmed breakdown through the recent 20-candle low.
```

## Supported Instruments

Implementation currently accepts:

```text
STK
IND
```

The shared profile currently lists broader secTypes, but the strategy implementation still rejects anything other than `STK` and `IND`.

## Direction

```text
SHORT only
side = SELL
```

## Required Market Context

```text
directionalRegime = bear_trend
volatilityRegime = high_volatility
```

The shared profile currently allows only `high_volatility`. The strategy implementation itself accepts `normal_volatility` and `high_volatility`, but the portfolio profile gates the default bot/backtest to `high_volatility`.

Hard rejects inside the strategy:

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

## Core Filters

Required indicators:

- EMA20,
- EMA50,
- EMA200,
- RSI14,
- ATR14,
- Donchian lower 20.

Current timeframe alignment:

```text
close < EMA200
close < EMA50
EMA20 < EMA50
RSI14 > 28
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

Distance from moving averages:

```text
distanceBelowEma20Pct <= 1.5
distanceBelowEma50Pct <= 5
```

Intraday momentum filters:

```text
return20mPct >= -1.2
return60mPct >= -3
return60mPct <= -0.2
```

Volatility/compression filter:

```text
bbWidthPct <= 0.08
```

## Entry Logic

The strategy confirms a breakdown below the previous 20-candle low.

```text
priorLow20 = min(low over previous 20 candles excluding current)
breakdownBuffer = max(ATR14 * 0.015, close * 0.00025)
validBreakdown = close <= priorLow20 - breakdownBuffer
```

It also checks pre-breakdown drift:

```text
preBreakdownDriftPct >= -0.8
```

This avoids shorting after the move has already extended too far.

## Volume Filter

```text
previousAverageVolume = average previous 20 1m candles
latestVolume >= previousAverageVolume * 0.95
```

## Candle Quality

The breakdown candle must be bearish and close with good quality:

```text
close < open
close near low
bodyPct >= 0.12
lowerWickPct <= 0.45
```

## Stop Loss

```text
atrStop = close + ATR14 * 1.5
structureStop = min(localConsolidationHigh20, close + ATR14 * 2.5)
stopLoss = max(atrStop, structureStop)
```

## Take Profit

```text
riskPerShare = stopLoss - close
takeProfit = close - riskPerShare * 3
plannedRewardPct >= 0.6
```

## Scoring

Base confidence:

```text
0.58
```

Additive components:

- EMA trend strength,
- breakdown distance,
- RSI weakness without oversold extension,
- Bollinger compression.

Confidence is clamped to:

```text
0.58 - 0.88
```

---

# gap_fade_short_v1

## Status

Active in bot/backtest by default.

```text
enabledInBot = true
```

## Purpose

Short-only intraday gap fade strategy.

Hypothesis:

```text
Some gap-up moves fail to continue after the open and partially fade back toward VWAP or the previous session close.
```

This is a reversal strategy, not a trend-following strategy. It uses intraday session metadata and only trades inside the early-session fade window.

## Supported Instruments

```text
STK
IND
ETF
```

## Direction

```text
SHORT only
side = SELL
```

## Required Market Context

The profile allows all directional regimes:

```text
directionalRegime = bull_trend | range | bear_trend
```

Allowed volatility:

```text
volatilityRegime = normal_volatility | high_volatility
```

The strategy does not trade `low_volatility` because the portfolio manager filters it out through the profile.

## Required Timeframes

```text
1m
```

It also requires the `intraday` snapshot from `SignalEngine`.

## Required Intraday Fields

The strategy requires:

- session open,
- previous session close,
- gap percent,
- minutes since session open,
- session VWAP,
- distance from VWAP in basis points.

If these are unavailable, the strategy rejects with:

```text
intraday_metadata_unavailable
intraday_fields_incomplete
```

## Gap Filter

```text
gapMinPct = 1.0
gapMaxPct = 5.0
```

Rejects:

```text
gapPct < 1.0  -> gap_too_small
gapPct > 5.0  -> gap_too_large_news_risk
```

Large gaps are treated as likely news-driven and too dangerous to fade.

## Time Window

The fade is allowed only early in the session:

```text
minutesSinceSessionOpen >= 5
minutesSinceSessionOpen <= 90
```

The strategy also requires UTC liquid-hours filter:

```text
sessionUtcStartHour = 8
sessionUtcEndHour = 19
```

## Momentum Filter

```text
RSI14 >= 55
RSI14 <= 75
```

Rejects:

- too weak: `rsi_not_elevated`
- too strong/blow-off risk: `rsi_blowoff_avoid`

## VWAP Filter

Price must still be above VWAP with enough distance to fade:

```text
distanceFromVwapBps >= 20
```

It also must still be above the previous session close:

```text
close > prevSessionClose
```

If price is already below previous close, the gap is considered filled.

## Volume Filter

```text
previousAverageVolume = average previous 20 1m candles
latestVolume >= previousAverageVolume * 1.3
```

The trigger candle needs elevated volume because weak-volume fades are more likely to fail.

## Trigger Candle

The trigger candle must show bearish rejection:

```text
close < open
closeLocationPct <= 0.40
bodyPct >= 0.15
```

Here `closeLocationPct = 0` means close at candle low and `1` means close at candle high.

## Stop Loss

```text
atrStop = close + ATR14 * 1.2
stopLoss = max(sessionOpen, atrStop)
```

The stop must be above the current close.

## Take Profit

The target is a partial gap fill:

```text
gapAbs = sessionOpen - prevSessionClose
takeProfit = sessionOpen - gapAbs * 0.7
```

So default TP is a 70% gap fade, not necessarily a full gap fill.

Minimum reward:

```text
plannedRewardPct >= 0.4
rMultiple >= 1
```

## Scoring

Base confidence:

```text
0.60
```

Additive components:

- gap size within accepted bounds,
- RSI elevation,
- distance above VWAP,
- candle quality.

Confidence is clamped to:

```text
0.60 - 0.90
```

Typical rejection reasons:

- `sec_type_not_supported`
- `outside_strategy_session`
- `missing_required_indicators`
- `intraday_metadata_unavailable`
- `intraday_fields_incomplete`
- `gap_too_small`
- `gap_too_large_news_risk`
- `too_early_in_session`
- `fade_window_expired`
- `rsi_not_elevated`
- `rsi_blowoff_avoid`
- `gap_already_filled`
- `price_too_close_to_vwap`
- `volume_baseline_unavailable`
- `volume_not_confirmed`
- `trigger_candle_not_bearish`
- `trigger_close_not_near_low`
- `trigger_body_too_small`
- `invalid_stop_loss`
- `invalid_take_profit`
- `planned_reward_too_small`
- `reward_to_risk_below_1`

---

# range_reversal_v1

## Status

Implemented but disabled in the default bot/backtest portfolio.

```text
enabledInBot = false
```

It remains available for isolated / strategy-lab research.

The current reason for disabling it in the profile:

```text
Temporarily disabled in bot: net negative across all tuning iterations (#87..#89).
```

## Purpose

Two-sided mean-reversion strategy for range markets.

Hypothesis:

```text
In a non-trending market, price can reject the upper/lower edge of a defined range and rotate back toward the middle.
```

## Supported Instruments

```text
STK
IND
ETF
CMDTY
FUT
```

## Direction

```text
LONG and SHORT
BUY near lower range edge
SELL near upper range edge
```

## Required Market Context

```text
directionalRegime = range
volatilityRegime = normal_volatility | high_volatility
```

Hard rejects:

```text
directionalRegime != range
volatilityRegime == low_volatility
```

## Core Indicators

Required:

- ATR14,
- RSI14,
- Bollinger upper/middle/lower,
- Donchian upper/lower 20.

Optional hard guards when available:

- CMF20,
- MFI14.

## Range Definition

```text
rangeLow = dcLower20
rangeHigh = dcUpper20
rangeWidthPct = (rangeHigh - rangeLow) / close * 100
```

Valid range width:

```text
0.45 <= rangeWidthPct <= 8
```

## Long Setup

The long setup requires rejection near the lower edge:

```text
edgeDistance = min(abs(close - bbLower), abs(close - dcLower20))
edgeThreshold = max(ATR14 * 0.45, close * 0.25%)
edgeDistance <= edgeThreshold
RSI14 <= 42
close > open
closeLocationPct >= 0.58
bodyPct >= 0.08
lowerWickPct >= 0.18
```

Money-flow rejects:

```text
CMF20 < -0.2
MFI14 < 18
```

## Short Setup

The short setup requires rejection near the upper edge:

```text
edgeDistance = min(abs(close - bbUpper), abs(close - dcUpper20))
edgeThreshold = max(ATR14 * 0.45, close * 0.25%)
edgeDistance <= edgeThreshold
RSI14 >= 58
close < open
close near lower part of candle range
bodyPct >= 0.08
upperWickPct >= 0.18
```

Money-flow rejects:

```text
CMF20 > 0.2
MFI14 > 82
```

## Volume Filter

```text
previousAverageVolume = average previous 20 1m candles
latestVolume >= previousAverageVolume * 0.8
```

## Stop Loss

Long:

```text
atrStop = close - ATR14 * 1.25
structureStop = max(swingLow20, close - ATR14 * 2.2)
stopLoss = min(atrStop, structureStop)
```

Short:

```text
atrStop = close + ATR14 * 1.25
structureStop = min(swingHigh20, close + ATR14 * 2.2)
stopLoss = max(atrStop, structureStop)
```

## Take Profit

Long:

```text
takeProfit = min(Bollinger middle, close + 0.5 * Donchian range width)
```

Short:

```text
takeProfit = max(Bollinger middle, close - 0.5 * Donchian range width)
```

## Reward/Risk

Normal volatility:

```text
rewardRisk >= 0.9
```

High volatility:

```text
rewardRisk >= 1.1
```

## Scoring

Base confidence:

```text
0.58
```

Additive components:

- edge proximity,
- RSI stretch,
- rejection candle quality,
- wick quality.

Confidence is clamped to:

```text
0.58 - 0.84
```

---

# trend_following_long_v1

## Status

Implemented but disabled in the default bot/backtest portfolio.

```text
enabledInBot = false
```

Available through the registry for isolated research / strategy-lab runs.

## Purpose

Daily-timeframe Donchian-breakout trend-following.

Hypothesis:

```text
A confirmed multi-week bull regime + a fresh N-day Donchian high on the daily candle, in a non-overbought RSI band, leads to continuation over multi-day to multi-week holding periods.
```

It is intentionally slower and lower-frequency than `momentum_breakout_long_v1`, and sized using D1 ATR so the stop reflects daily noise, not intraday noise.

## Supported Instruments

```text
STK
IND
```

## Direction

```text
LONG only
side = BUY
```

## Required Market Context

```text
directionalRegime = bull_trend
volatilityRegime = normal_volatility | high_volatility
```

Hard rejects:

```text
directionalRegime != bull_trend
volatilityRegime == low_volatility
regimeScore < 5
```

## Required Timeframes

```text
1m  (for live close used as entry/sizing reference)
1d  (for the breakout setup itself)
```

Requires at least `donchianWindow + 2` D1 candles.

## Session Window

The entry trigger is gated to an extended UTC session window so the engine doesn't open new D1 trend trades at illiquid hours:

```text
sessionUtcStartHour = 8
sessionUtcEndHour   = 20
```

## Core Filters

```text
closeD > EMA50D
RSI14D in [50, 72]
ATR14D > 0
```

EMA200 D1 is not used as a hard gate because the current dataset has 121–142 D1 candles per symbol (EMA200 needs 200). The multi-timeframe `regimeScore` and `directionalRegime = bull_trend` carry that role instead.

## Entry Logic — Donchian Breakout

```text
priorHigh = max(high) over prior 50 D1 candles (excluding the current/latest D1)
breakoutLevel = priorHigh * (1 + 0.05%)
closeD > breakoutLevel
```

## Volume Filter

```text
avgVol20D = average volume over prior 20 D1 candles (excluding the latest)
latestD1.volume >= avgVol20D * 1.1
```

Volume confirmation is required when the average is positive.

## Stop Loss

Sized in D1-noise units, anchored to the live 1m close (which is also the planned entry):

```text
stop = liveClose - 2.0 * ATR14D
```

Rejected if the stop ends up at or above the entry.

## Take Profit

```text
takeProfit = liveClose + 5.0 * (liveClose - stop)
plannedRewardPct >= 1.5
```

## Scoring

Base confidence:

```text
0.88
```

Bonuses:

- `regimeBonus` up to `+0.05` based on how far `regimeScore` exceeds 10
- `breakoutCleanlinessBonus` up to `+0.04` based on how cleanly the daily close beat `priorHigh`

Confidence is clamped to:

```text
0.88 - 0.97
```

The high anchor is intentional: when both `momentum_breakout_long_v1` and `trend_following_long_v1` fire on the same candle, the daily setup should dominate.

---

# Portfolio Notes

The portfolio manager runs all active strategy implementations and selects the highest-confidence valid signal.

Current default active portfolio:

```text
momentum_breakout_long_v1:
  bull_trend + normal/high volatility

momentum_breakdown_short_v1:
  bear_trend + high volatility

gap_fade_short_v1:
  bull_trend/range/bear_trend + normal/high volatility
```

Disabled but implemented:

```text
range_reversal_v1:
  range + normal/high volatility

trend_following_long_v1:
  bull_trend + normal/high volatility (D1-driven, longer holding period)
```

No active strategy currently targets:

```text
range + low_volatility
bull_trend + low_volatility
bear_trend + low_volatility
```

Those should remain separate strategies, not relaxed versions of the existing momentum/reversal logic.

## Symbol Exclusions

`StrategyProfile` supports optional per-strategy `excludedSymbols`.

The SignalEngine should skip a strategy for a symbol listed in that strategy profile's `excludedSymbols` array. Symbols are treated case-insensitively.
