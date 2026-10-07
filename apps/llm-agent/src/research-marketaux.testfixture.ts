import { researchFixture } from "@ikbr/shared/instrument-research-testfixture";
import { marketauxSourceUrl, marketauxWindow, researchHash, type MarketauxNewsConfig, type MarketauxRequest, type ResearchSource } from "@ikbr/shared/instrument-research";
import { createHash } from "node:crypto";

export function marketauxFixture(now = Date.now(), instrumentId = "aapl_smart") {
  const f = researchFixture(now, instrumentId);
  const config: MarketauxNewsConfig = {
    kind: "marketaux-news-v1", entity: { symbol: "FIXTURE", name: "Synthetic Issuer", type: "equity", country: "us", exchange: null },
    qualification: { outcome: "VERIFIED", verifiedAt: new Date(now - 86400000).toISOString(), expiresAt: new Date(now + 3600000).toISOString(), evidenceUrl: "https://api.marketaux.com/v1/entity/search?symbols=FIXTURE", receiptHash: "a".repeat(64), issuerIdentifier: f.policy.identifiers[0], conId: f.policy.listing.conId },
    entitlement: { outcome: "VERIFIED", verifiedAt: new Date(now - 86400000).toISOString(), expiresAt: new Date(now + 3600000).toISOString(), evidenceUrl: "https://www.marketaux.com/pricing", receiptHash: "b".repeat(64), maxArticlesPerRequest: 100, maxRequestsPerDay: 1000, maxCostMicrosPerDay: 1000 },
    pageSize: 2, maxPagesPerPass: 10, maxArticles: 20,
  };
  const source: ResearchSource = { id: "marketaux-fixture", provider: "https://api.marketaux.com", adapter: "marketaux-news", parserConfig: config as unknown as Record<string, unknown>, roles: ["news"], urls: [marketauxSourceUrl(config)], issuerIdentifier: f.policy.identifiers[0], automation: "PERMITTED", retention: "FACTS_AND_REFERENCES", permissionEvidenceUrl: "https://www.marketaux.com/documentation", maxRequestsPerDay: 1000, maxCostMicrosPerDay: 1000, costMicrosPerCall: 1 };
  f.policy.sources[0].roles = ["reports", "calendar"];
  f.policy.sources.push(source);
  f.manifest.refreshEnabled = true;
  f.snapshot.coverage = f.snapshot.coverage.filter(c => c.role !== "news");
  f.manifestHash = researchHash(f.manifest); f.snapshot.manifestHash = f.manifestHash; f.snapshot.mappingHash = researchHash(f.policy);
  const slot = Math.floor(now / 900000), window = marketauxWindow(slot);
  const descriptor: MarketauxRequest = { sourceUrl: source.urls[0], ...window, pass: 1, page: 1 };
  const article = (n: number, at = new Date(Date.parse(window.asOf) - 60000).toISOString()) => ({ uuid: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`, title: `Synthetic article ${n}`, url: `https://news.example.org/${n}`, published_at: at, entities: [{ ...config.entity }], similar: [] });
  return { ...f, source, newsConfig: config, now, slot, descriptor, article };
}

export function marketauxResponse(data: unknown[], page: number, found: number, limit = 2) {
  const payload = Buffer.from(JSON.stringify({ meta: { found, returned: data.length, limit, page }, data }));
  return { payload, contentHash: createHash("sha256").update(payload).digest("hex"), contentType: "application/json" };
}
