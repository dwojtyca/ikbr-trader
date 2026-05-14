# Strategy Documentation

## Active Strategy Set

The default bot/backtest strategy set is driven by `packages/shared/src/strategy-profiles.ts`.

Currently active:

- `momentum_breakout_long_v1`
- `failed_bounce_short_v1`

Implemented but not active by default:

- `momentum_breakdown_short_v1`

---

## failed_bounce_short_v1

### Purpose

`failed_bounce_short_v1` is a short strategy designed to detect a failed relief rally inside a broader bearish trend.

The strategy does not short panic breakdowns. It waits for price to bounce into a resistance area, lose momentum, and close back below short-term trend resistance before generating a short candidate.

Expected market structure:

```text
bear trend -> short-term bounce -> retest of EMA20/EMA50 -> rejection -> continuation lower
```

The strategy is intended for regulated markets and liquid instruments:

- stocks
- indexes
- ETFs
- commodities

For live trading, the execution/risk layer must still validate short availability, borrow cost, margin, event risk, spread, liquidity, and whether an inverse ETF is preferable to direct shorting.

### Indicator Set

Trend:

- EMA20
- EMA50
- EMA200
- SMA200

Momentum:

- RSI14
- MACD histogram

Volatility:

- ATR14
- Bollinger Bands width

Volume / money flow:

- CMF20
- MFI14
- optional OBV slope

### Required Regime

The strategy only runs in:

```text
bear_trend
```

If the regime detector does not classify the instrument as `bear_trend`, the strategy must reject the setup.

### Bear Trend Detection

The D1 trend is the primary trend filter.

Required daily conditions:

```text
D1 close < D1 SMA200
D1 close < D1 EMA50
D1 EMA20 < D1 EMA50
D1 EMA50 slope over last 10 candles < 0
D1 ADX14 >= 22
```

The intraday/current snapshot must also be aligned:

```text
close < EMA200
close < EMA50
EMA20 < EMA50
close < EMA20 after rejection
```

This combination avoids shorting normal pullbacks inside a broader bull trend.

### Bounce Detection

A valid bounce means price has moved back toward real resistance without invalidating the bearish trend.

Accepted resistance zones:

```text
EMA20/EMA50 area
previous pivot support retested from below
Bollinger middle or upper band
```

The setup candle, not the trigger candle, must retest one of those zones:

```text
setupCandle.high >= resistanceLevel * (1 - resistanceTolerancePct)
```

Default:

```text
resistanceTolerancePct = 0.35
```

This prevents shorting a random EMA touch without evidence that price actually rejected supply.

### Failed Bounce Confirmation

The strategy separates setup from trigger.

Setup candle requirements:

```text
setup candle touches resistance
setup candle has visible upper wick
setup candle closes away from the high
```

Trigger candle requirements:

```text
close < open
close < setupCandle.low
close near lower part of candle range
body is not too small
```

The emitted order is a stop entry:

```text
entryOrderType = STP
entryStop = triggerCandle.low - max(0.05 * ATR14, close * 3 bps)
```

So the strategy only enters if price continues below the confirmation candle instead of shorting immediately at the first EMA touch.

Current default constraints:

```text
closeLocationMin = 0.55
bodyMin = 0.10
upperWickMin = 0.12
```

Interpretation:

- close near low confirms seller control,
- bearish body confirms bounce failure,
- upper wick confirms rejection from resistance.

### Momentum Filters

RSI:

```text
rsiMin = 30
rsiMax = 50
```

Reject if:

```text
RSI14 <= 30
RSI14 >= 50
```

Reasoning:

- RSI below 30 often means the move is already too extended.
- RSI above 58 suggests the bounce may still have strength.

MACD:

The histogram must weaken for two consecutive bars:

```text
macdHist < macdHistPrev < macdHistPrev2
```

### Money Flow Filters

CMF20:

Bearish money flow improves the setup:

```text
CMF20 < 0
```

Hard reject:

```text
CMF20 > 0.08
```

MFI14:

Weakening MFI improves the setup:

```text
MFI14 < MFI14Prev
```

Hard reject:

```text
MFI14 > 65
```

These filters reduce false positives where price appears to reject EMA resistance, but real money flow still supports the bounce.

### Volatility Filters

The strategy uses Bollinger Band width and ATR.

Reject if Bollinger width is too wide:

```text
bbWidthPct > 0.10
```

Reasoning:

- Very wide bands often mean news, panic, or unstable volatility.
- Failed bounce setups should occur after controlled counter-trend movement, not during chaotic repricing.

ATR is used for stop construction and risk normalization.

ADX is used as a trend filter:

```text
D1 ADX14 >= 22
```

This is mandatory because failed-bounce shorts tend to degrade quickly in chop/range.

### Overextension Filters

The strategy must avoid shorting too late after a selloff.

Current filters:

```text
return20mPct >= -1.4
return60mPct >= -2.5
distanceBelowEma20Pct <= 1.2
```

It also rejects bounces that are too strong:

```text
return20mPct <= 1.2
return60mPct <= 2.0
```

### Stop Loss

The stop is structure-aware and ATR-aware.

```text
rejectionBuffer = max(0.1 * ATR14, entryStop * 0.0005)
atrStop = entryStop + ATR14 * stopAtrMult
structureStop = rejectionHigh + rejectionBuffer
stopLoss = max(atrStop, structureStop)
```

Defaults:

```text
stopAtrMult = 1.6
structureStopAtrMult = 2.6
```

The stop is rejected if it is invalid or too wide:

```text
stopLoss <= entryStop -> reject
stopLoss > entryStop + ATR14 * structureStopAtrMult -> reject
```

### Targets

The strategy uses R-multiple target construction.

```text
riskPerShare = stopLoss - entryStop
tp1 = entryStop - riskPerShare * 1R
takeProfit = entryStop - riskPerShare * takeProfitR
```

Default:

```text
tp1R = 1.0
takeProfitR = 2.5
```

Current execution/backtest still supports one protective take-profit order. The strategy writes TP1 and breakeven intent into metadata, but actual partial close and stop-to-breakeven require a separate position-management layer.

Minimum planned reward:

```text
plannedRewardMinPct = 0.45
```

The strategy rejects setups where target distance is too small to justify execution costs and slippage.

### Scoring

The strategy has mandatory filters first, then scoring.

Default entry threshold:

```text
minScore = 7.0
```

Current scoring components:

```text
dailyBearTrend:        +2.00
dailyEmaAlignment:    +1.25
dailyEma50Falling:    +1.00
dailyAdxTrend:        +0.60 to +1.00
intradayEmaAlignment: +1.00
resistanceRetest:     +0.35 to +1.40
confirmedBreak:       +1.00
closeBackBelowEma20:  +0.75
bearishRejection:     +0.60 to +1.00
rsiRollingOver:       +0.75
macdWeakening:        +1.00
moneyFlowBearish:     +0.80
mfiWeakening:         +0.50
obvWeakening:         +0.30
```

Signal confidence is derived from score:

```text
confidenceScore = clamp(0.5 + score / 20, 0, 0.88)
```

### Decision Pipeline

Execution order:

1. Check supported `secType`.
2. Check `bear_trend` regime.
3. Check session window.
4. Validate required indicators.
5. Validate higher timeframe availability.
6. Reject bullish H1/H4/D1 alignment.
7. Validate D1 bearish trend, falling EMA50, and ADX.
8. Validate current EMA/SMA alignment.
9. Detect setup candle bounce into EMA/Bollinger/prior-support resistance.
10. Require trigger candle close below setup low.
11. Validate RSI/MACD/CMF/MFI.
12. Reject overextended selloffs.
13. Validate volatility.
14. Validate volume and minimum notional liquidity.
15. Validate setup and trigger candle quality.
16. Build stop-entry below trigger candle low.
17. Build ATR/structure stop.
18. Build TP1 metadata and final R-multiple take profit.
19. Calculate score.
20. Emit `StrategySignal` only if score and risk constraints pass.

### Rejection Examples

Common rejection reasons:

```text
regime_not_bear_trend
daily_close_above_sma200
daily_close_above_ema50
daily_ema20_not_below_ema50
daily_ema50_not_falling
daily_adx_too_low
close_not_back_below_ema20
no_resistance_retest
trigger_close_not_below_setup_low
rejection_candle_not_bearish
money_flow_too_positive
mfi_too_strong
macd_hist_not_falling_two_bars
too_far_below_ema20
stop_too_wide
score_too_low
```

### Timeframe Model

Primary timeframe:

- D1 trend filter.

Current strategy context:

- latest/current candle snapshot for execution timing.

Higher timeframe confirmations:

- H1
- H4
- D1

For indexes and ETFs:

- prefer D1 as the dominant filter,
- avoid noisy low-timeframe overfitting.

For commodities:

- W1 trend filter can be added later,
- recommended condition: W1 close below EMA20 or W1 EMA20 below EMA50.

### Production Considerations

The strategy itself only emits a candidate signal.

The risk/execution layer must still check:

- borrow availability,
- borrow fee,
- short sale restrictions,
- instrument margin,
- spread and liquidity,
- earnings blackout,
- macro-event blackout,
- gap risk,
- max exposure,
- max open positions,
- order TTL,
- whether to route as direct short or inverse ETF.

Current code limitation: broad-market confirmation for USA stocks/ETFs, earnings blackout, and macro-event blackout require external data in `StrategyContext`. They are not enforced inside the strategy until SPY/QQQ market snapshots and event calendars are available.

### Optimization Guidance

Avoid optimizing too many parameters at once.

Reasonable tuning order:

1. `minScore`
2. `takeProfitR`
3. `stopAtrMult`
4. `resistanceTolerancePct`
5. `maxDistanceBelowEma20Pct`
6. RSI / MFI / CMF thresholds

Primary evaluation metrics:

- net PnL,
- profit factor,
- max drawdown,
- trade count,
- win rate,
- average R,
- symbol concentration,
- sensitivity across years.

The strategy should not be judged only by win rate.

---

## momentum_breakout_long_v1

### Purpose

`momentum_breakout_long_v1` is the primary long-side momentum continuation strategy.

It looks for strong instruments in a bullish regime that consolidate and then break higher.

High-level logic:

```text
bull trend -> consolidation -> confirmed breakout -> long
```

The strategy is intentionally simple and production-oriented. It does not try to predict bottoms or buy weak instruments. It waits for an already strong instrument to prove continuation after a controlled consolidation.

Supported instruments:

- stocks
- indexes

### Required Regime

The strategy only runs in:

```text
bull_trend
```

If the market regime detector does not classify the symbol as `bull_trend`, the strategy rejects the setup immediately.

### Trend Requirements

The current candle snapshot must confirm bullish alignment:

```text
close > EMA200
close > EMA50
EMA20 > EMA50
```

Higher timeframe filters must not be bearish:

```text
H1 trend != bearish
H4 trend != bearish
D1 trend != bearish
```

The strategy also requires momentum confirmation from higher timeframes:

```text
D1 return20Pct >= 8
H1 return4Pct >= 1
```

Interpretation:

- D1 confirms that the instrument is in a strong recent trend.
- H1 confirms that the breakout is not happening against dead short-term momentum.
- EMA alignment prevents buying into a broader downtrend.

### Consolidation Detection

The strategy expects price to consolidate before the breakout. It measures pre-breakout drift over the previous 20 one-minute candles, excluding the current breakout candle.

```text
preBreakoutDriftPct <= 0.8
```

This avoids buying after a move that has already run too far before the signal candle.

The strategy also uses Bollinger Band width as a compression filter:

```text
bbWidthPct <= 0.08
```

Reasoning:

- A breakout after compression is more attractive than chasing a move after volatility has already expanded.
- Very wide bands often mean the market is already repricing aggressively, which increases late-entry risk.

### Breakout Confirmation

The breakout is confirmed against the previous 20-candle high:

```text
priorHigh20 = max(high of previous 20 candles)
breakoutBuffer = max(0.015 * ATR14, close * 0.00025)
close >= priorHigh20 + breakoutBuffer
```

This means the strategy does not buy a simple touch of resistance. It requires a close above the previous local high plus a small ATR/price buffer.

The implementation also requires Donchian upper 20 to be available:

```text
dcUpper20 is defined
```

The current entry mode is:

```text
entryMode = breakout_20
```

### Momentum Filters

RSI:

```text
RSI14 < 72
```

Reject reason:

```text
rsi_overheated
```

The strategy wants momentum, but not an obviously overheated candle.

Short-term returns:

```text
return20mPct <= 1.2
return60mPct >= 0.2
return60mPct <= 3.0
```

Interpretation:

- `return60mPct >= 0.2` confirms enough intraday strength.
- `return20mPct <= 1.2` and `return60mPct <= 3.0` avoid buying too late after a strong intraday run.

### Volume Confirmation

The breakout candle must have acceptable volume relative to the previous 20 candles:

```text
latestVolume >= averageVolume20 * 0.95
```

Reject reason:

```text
volume_not_confirmed
```

This is intentionally not a very aggressive volume multiplier. The goal is to filter out weak, illiquid breakouts without requiring a large volume spike on every valid signal.

### Breakout Candle Quality

The breakout candle must look like real buyer control:

```text
close > open
closeLocationPct >= 0.60
bodyPct >= 0.12
upperWickPct <= 0.45
```

Meaning:

- candle must be bullish,
- close should be in the upper part of the range,
- body cannot be tiny,
- upper wick cannot dominate the candle.

Reject reasons:

```text
breakout_candle_not_bullish
breakout_close_not_near_high
breakout_body_too_small
breakout_upper_wick_too_large
```

### Stop Loss

The stop is built from ATR and local consolidation structure.

ATR stop:

```text
atrStop = close - ATR14 * 2
```

Structure stop:

```text
consolidationLow = min(low of last 20 candles)
structureStop = max(consolidationLow, close - ATR14 * 3)
```

Final stop:

```text
stopLoss = min(atrStop, structureStop ?? atrStop)
```

Interpretation:

- ATR provides a volatility-adjusted minimum stop distance.
- Consolidation low keeps the stop connected to local structure.
- `structureStopAtrMult = 3` prevents structure stop from becoming absurdly wide.

Invalid setup:

```text
stopLoss >= close -> reject
```

### Take Profit

The strategy uses a fixed R-multiple target:

```text
riskPerShare = close - stopLoss
takeProfit = close + riskPerShare * 4
```

Default:

```text
takeProfitR = 4
```

Minimum planned reward:

```text
plannedRewardPct >= 0.6
```

Reject reason:

```text
planned_reward_too_small
```

The high target multiple is intentional: current backtests show many stop-outs, so the strategy depends on larger winners to offset frequent small losses.

### Confidence Scoring

The strategy uses mandatory filters first, then builds a confidence score.

Base:

```text
0.58
```

Components:

```text
trendScore       = clamp(((EMA20 - EMA50) / close) * 150, 0, 0.18)
breakoutScore    = clamp(((close - priorHigh20) / close) * 3500, 0, 0.12)
rsiScore         = +0.10 when 55 <= RSI14 < 72
                 = +0.06 when 50 < RSI14 < 55
compressionScore = up to +0.08 when BB width is below max
```

Final:

```text
confidenceScore = clamp(0.58 + trendScore + breakoutScore + rsiScore + compressionScore, 0, 0.88)
```

Scoring meaning:

- EMA spread rewards clean trend alignment.
- Breakout distance rewards a stronger close through resistance.
- RSI rewards constructive momentum, but caps overheated setups.
- Compression rewards breakouts after quieter conditions.

### Decision Pipeline

Execution order:

1. Check supported `secType`.
2. Check `bull_trend` regime.
3. Check UTC session window.
4. Validate required indicators.
5. Validate H1/H4/D1 availability.
6. Reject bearish higher timeframe alignment.
7. Require D1 and H1 momentum.
8. Validate EMA trend alignment.
9. Reject overheated RSI.
10. Reject short-term overextension or weak intraday momentum.
11. Validate Bollinger compression.
12. Confirm breakout above previous 20-candle high with buffer.
13. Confirm consolidation drift was not too high before breakout.
14. Validate volume.
15. Validate breakout candle quality.
16. Build ATR/structure stop.
17. Build R-multiple take profit.
18. Calculate confidence.
19. Emit `StrategySignal`.

### Common Rejection Reasons

```text
regime_not_bull_trend
outside_strategy_session
missing_required_indicators
higher_timeframe_unavailable
higher_timeframe_1h_bearish
higher_timeframe_4h_bearish
higher_timeframe_1d_bearish
daily_momentum_too_weak
hourly_momentum_too_weak
close_below_ema200
close_below_ema50
ema20_not_above_ema50
rsi_overheated
overextended_20m
overextended_60m
intraday_momentum_too_weak
volatility_not_compressed
prior_high_unavailable
no_confirmed_breakout
consolidation_drift_unavailable
pre_breakout_drift_too_high
volume_baseline_unavailable
volume_not_confirmed
breakout_candle_not_bullish
breakout_close_not_near_high
breakout_body_too_small
breakout_upper_wick_too_large
invalid_stop_loss
planned_reward_too_small
```

### Parameters

Current defaults:

```text
dailyReturn20MinPct = 8
h1Return4MinPct = 1
return20MaxPct = 1.2
return60MinPct = 0.2
return60MaxPct = 3
consolidationDriftMaxPct = 0.8
rsiMax = 72
bbWidthMaxPct = 0.08
volumeMultiplier = 0.95
closeLocationMin = 0.60
bodyMin = 0.12
upperWickMax = 0.45
plannedRewardMinPct = 0.60
stopAtrMult = 2
structureStopAtrMult = 3
takeProfitR = 4
sessionUtcStartHour = 8
sessionUtcEndHour = 20
```

### Production Notes

The strategy only emits a candidate. It does not execute orders.

Risk/execution still decides:

- position size,
- max exposure,
- max open positions,
- limit entry price,
- bracket order validity,
- tick rounding,
- broker acceptance.

This strategy is currently the main positive contributor in bot backtests and should be treated as the long-side baseline.

---

## momentum_breakdown_short_v1

`momentum_breakdown_short_v1` is the currently active short-side strategy in the default bot portfolio.

It is a direct bearish breakdown strategy:

```text
bear trend -> consolidation -> break below recent low -> short
```

It is materially weaker than `momentum_breakout_long_v1`, but run `#72` showed that it still added positive net PnL when combined with the long strategy. It is therefore active as the current short baseline while `failed_bounce_short_v1` remains experimental in strategy lab.
