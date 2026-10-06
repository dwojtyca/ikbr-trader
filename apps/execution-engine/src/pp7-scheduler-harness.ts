import assert from 'node:assert/strict';
import { buildInstrumentSessionIdentity, sessionDateAt, sessionLocalMidnight, sessionCandleSlots, sessionNativeSource, type BoundInstrument, type Candle, type SessionTimeframe, type SessionScheduleEvidence } from '@ikbr/shared';
export const signalModule = (path: string) => import(new URL(`../../signal-engine/src/${path}`, import.meta.url).href);
export const llmModule = (path: string) => import(new URL(`../../llm-agent/src/${path}`, import.meta.url).href);
export async function nativeBreakoutCandles(bound: BoundInstrument, now: Date) {
    const evidence = syntheticHistorySchedule(bound, now);
    const candles: Record<string, Candle[]> = {};
    for (const tf of ['1m', '5m', '1h', '4h', '1d'] as SessionTimeframe[]) {
        const slots = sessionCandleSlots(evidence.schedule!, tf).filter(slot => Date.parse(slot.end) <= now.getTime()).slice(tf === '1m' ? -300 : -60);
        candles[tf] = slots.map(slot => ({
            conid: String(bound.conId), symbol: bound.brokerSymbol, timeframe: tf, ts: new Date(slot.start), source: sessionNativeSource(evidence.schedule!.identity), open: 100, high: 101, low: 99, close: 100, volume: 1000
        }));
    }
    for (const [tf, rows] of Object.entries(candles))
        for (let i = 0; i < rows.length; i++) {
            const close = tf === '1m' ? (i < rows.length - 65 ? 95 + i * .014 : 99.2 + (i - (rows.length - 65)) * .01 + Math.sin(i * 1.7) * .12) : 60 + i * .8;
            Object.assign(rows[i], { open: close - .04, high: close + .16, low: close - .16, close, volume: 1000 });
        }
    const row = candles['1m'].at(-1)!;
    Object.assign(row, { open: 99.75, low: 99.70, high: 100.25, close: 100.2, volume: 2500 });
    return candles;
}
export function capturedSchedulerTimers() {
    const callbacks: {
        startup?: () => void;
        tick?: () => void;
    } = {};
    return {
        callbacks,
        setTimeoutFn: ((fn: () => void) => { callbacks.startup = fn; return { unref() { } }; }) as unknown as typeof setTimeout,
        setIntervalFn: ((fn: () => void) => { callbacks.tick = fn; return { unref() { } }; }) as unknown as typeof setInterval,
        clearTimeoutFn() { }, clearIntervalFn() { }
    };
}
export async function awaitScheduler(service: {
    status(): {
        cycleCount: number;
        activeInstruments?: readonly string[];
        lastOutcomes: Record<string, unknown>;
    };
}, count = 1, reports = 1) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && (service.status().cycleCount < count || Object.keys(service.status().lastOutcomes).length < reports || (service.status().activeInstruments?.length ?? 0) > 0))
        await new Promise(r => setTimeout(r, 10));
    assert.ok(service.status().cycleCount >= count && Object.keys(service.status().lastOutcomes).length >= reports && (service.status().activeInstruments?.length ?? 0) === 0, 'scheduler did not finish');
}
export function syntheticHistorySchedule(bound: BoundInstrument, now: Date): SessionScheduleEvidence {
    const identity = buildInstrumentSessionIdentity(bound.instrument, bound), today = sessionDateAt(now.getTime(), identity.timeZone), noon = Date.parse(today + 'T12:00:00Z');
    const sessions = Array.from({ length: 102 }, (_, index) => { const day = index - 100, date = new Date(noon + day * 86400000).toISOString().slice(0, 10), start = sessionLocalMidnight(date, identity.timeZone); return { date, start: new Date(start).toISOString(), end: new Date(start + (day < 0 ? 4 : 24) * 3600000).toISOString() }; });
    return {
        status: 'READY', generation: 1, updatedAt: now.toISOString(), schedule: {
            source: 'ibkr_session_schedule_v1', identity, requestedAt: now.toISOString(), receivedAt: now.toISOString(), coverageStart: sessions[0].start, coverageEnd: sessions.at(-1)!.end, sessions
        }
    };
}
