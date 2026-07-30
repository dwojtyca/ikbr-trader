/**
 * PR15.1 — ingestion classifier (plan §4.3).
 */

import type { Transport } from "../http.js";
import type { ToolConfig } from "../config.js";
import {
  IngestionHealthSchema,
  IngestionWatchlistSchema,
  type IngestionWatchlist,
} from "../schema.js";
import {
  classifyHttp,
  reasonTokenForHttpProblem,
  severityForHttpProblem,
  type CheckResult,
} from "./types.js";

function ageMs(now: number, ts: string | number | null | undefined): number | null {
  if (ts === null || ts === undefined) return null;
  const parsed = typeof ts === "number" ? ts : Date.parse(ts);
  if (!Number.isFinite(parsed)) return null;
  return now - parsed;
}

export async function runIngestionChecks(
  transport: Transport,
  cfg: ToolConfig,
  now = Date.now(),
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const health = classifyHttp(
    await transport.get("INGESTION_HEALTH"),
    IngestionHealthSchema,
  );
  if (!health.ok) {
    const status = severityForHttpProblem(health);
    const token = reasonTokenForHttpProblem(health);
    results.push({
      id: "ingestion.health",
      service: "ingestion",
      status,
      summary: `ingestion /health failed: ${token}`,
      reasons: [`ingestion.health:${token}`],
    });
    results.push({
      id: "ingestion.watchlist",
      service: "ingestion",
      status: "DISABLED",
      summary: "watchlist skipped (health failed)",
      reasons: [],
    });
    return results;
  }
  const hp = health.json as {
    ok: boolean;
    connected: boolean;
    bootstrapped: boolean;
    bootstrapping: boolean;
    lastTickAt?: string | null;
    lastCandleAt?: string | null;
  };
  const reasons: string[] = [];
  if (!hp.ok) reasons.push("ok_false");
  if (!hp.connected) reasons.push("tws_not_connected");
  if (!hp.bootstrapped) reasons.push("not_bootstrapped");
  const tickAge = ageMs(now, hp.lastTickAt ?? null);
  if (tickAge === null || tickAge > cfg.maxTickAgeMs) {
    reasons.push("stale_last_tick");
  }
  const candleAgeGlobal = ageMs(now, hp.lastCandleAt ?? null);
  if (candleAgeGlobal !== null && candleAgeGlobal > cfg.maxCandleAgeMs) {
    reasons.push("stale_last_candle");
  }
  results.push({
    id: "ingestion.health",
    service: "ingestion",
    status: reasons.length === 0 ? "HEALTHY" : "UNHEALTHY",
    summary:
      reasons.length === 0
        ? "ingestion connected, bootstrapped, ticks flowing"
        : `ingestion health degraded: ${reasons.join(",")}`,
    reasons: reasons.map((r) => `ingestion.health:${r}`),
    details: {
      connected: hp.connected,
      bootstrapped: hp.bootstrapped,
      bootstrapping: hp.bootstrapping,
      lastTickAt: hp.lastTickAt ?? null,
      lastCandleAt: hp.lastCandleAt ?? null,
      lastTickAgeMs: tickAge,
      lastCandleAgeMs: candleAgeGlobal,
    },
  });

  const wl = classifyHttp(
    await transport.get("INGESTION_WATCHLIST"),
    IngestionWatchlistSchema,
  );
  if (!wl.ok) {
    results.push({
      id: "ingestion.watchlist",
      service: "ingestion",
      status: severityForHttpProblem(wl),
      summary: `ingestion /watchlist failed: ${reasonTokenForHttpProblem(wl)}`,
      reasons: [`ingestion.watchlist:${reasonTokenForHttpProblem(wl)}`],
    });
    return results;
  }
  const watchlist = wl.json as IngestionWatchlist;
  const wlReasons: string[] = [];
  const wlDegraded: string[] = [];
  if (watchlist.watchlist.length === 0) wlReasons.push("empty_watchlist");
  const subscribed = watchlist.watchlist.filter((w) => w.subscribed);
  if (subscribed.length === 0 && watchlist.watchlist.length > 0) {
    wlReasons.push("no_subscribed_symbol");
  }
  for (const item of subscribed) {
    if (!item.conid) wlReasons.push(`missing_conid:${item.symbol}`);
    if (!item.marketState) {
      wlReasons.push(`missing_market_state:${item.symbol}`);
      continue;
    }
    const stateAge = ageMs(now, item.marketState.ts);
    if (stateAge === null || stateAge > cfg.maxMarketStateAgeMs) {
      wlReasons.push(`stale_market_state:${item.symbol}`);
    }
    const candleAge = ageMs(now, item.latestCandle1m?.ts ?? null);
    if (candleAge !== null && candleAge > cfg.maxCandleAgeMs) {
      wlDegraded.push(`stale_candle:${item.symbol}`);
    }
  }
  const status =
    wlReasons.length > 0
      ? "UNHEALTHY"
      : wlDegraded.length > 0
        ? "DEGRADED"
        : "HEALTHY";
  results.push({
    id: "ingestion.watchlist",
    service: "ingestion",
    status,
    summary:
      status === "HEALTHY"
        ? `${subscribed.length}/${watchlist.watchlist.length} instruments subscribed and fresh`
        : status === "DEGRADED"
          ? `watchlist has ${wlDegraded.length} candle-freshness warning(s)`
          : `watchlist blocking: ${wlReasons.join(",")}`,
    reasons: [
      ...wlReasons.map((r) => `ingestion.watchlist:${r}`),
      ...wlDegraded.map((r) => `ingestion.watchlist:${r}`),
    ],
    details: {
      total: watchlist.watchlist.length,
      subscribed: subscribed.length,
    },
  });

  return results;
}
