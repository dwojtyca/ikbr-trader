import { researchHash, safeResearchUrl, type MarketauxEntity, type MarketauxNewsConfig, type MarketauxRequest } from "@ikbr/shared/instrument-research";

export interface MarketauxNewsRecord { uuid: string; title: string; url: string; publishedAt: string; originalPublishedAt: string; entity: MarketauxEntity; inWindow: boolean }
export interface MarketauxPage { found: number; returned: number; limit: number; page: number; records: MarketauxNewsRecord[] }
function invalid(): never { throw new Error("RESEARCH_MARKETAUX_PAYLOAD_INVALID"); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function timestamp(value: unknown): { micros: bigint; canonical: string; original: string } {
  if (typeof value !== "string") invalid();
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  if (!match) invalid();
  const base = Date.parse(match[1] + "Z");
  if (!Number.isFinite(base) || new Date(base).toISOString().slice(0, 19) !== match[1]) invalid();
  const micros = BigInt(base) * 1000n + BigInt((match[2] ?? "").padEnd(6, "0"));
  return { micros, canonical: new Date(Number(micros / 1000n)).toISOString(), original: value };
}

export function parseMarketauxPage(input: unknown, config: MarketauxNewsConfig, request: MarketauxRequest): MarketauxPage {
  const root = object(input), meta = object(root.meta);
  if (Object.hasOwn(root, "error") || Object.hasOwn(root, "errors") || !Array.isArray(root.data)) invalid();
  for (const key of ["found", "returned", "limit", "page"]) if (!Number.isSafeInteger(meta[key]) || Number(meta[key]) < 0) invalid();
  const found = meta.found as number, returned = meta.returned as number;
  const pages = Math.max(1, Math.ceil(found / config.pageSize));
  if (found > config.maxArticles || found > 20_000 || pages > config.maxPagesPerPass || pages * config.pageSize > 20_000) throw new Error("RESEARCH_MARKETAUX_RESULT_LIMIT");
  if (meta.limit !== config.pageSize || meta.page !== request.page || request.page > pages || returned !== root.data.length || returned !== Math.min(config.pageSize, Math.max(0, found - (request.page - 1) * config.pageSize))) invalid();
  const start = BigInt(Date.parse(request.windowStart)) * 1000n, end = BigInt(Date.parse(request.asOf)) * 1000n;
  const ids = new Set<string>();
  const records = root.data.map(raw => {
    const item = object(raw);
    if (typeof item.uuid !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(item.uuid) ||
      typeof item.title !== "string" || !item.title.trim() || item.title.length > 1000 || /[\u0000-\u001f\u007f]/.test(item.title) || !safeResearchUrl(item.url) || !Array.isArray(item.entities) ||
      (item.similar !== undefined && (!Array.isArray(item.similar) || item.similar.length !== 0))) invalid();
    const uuid = item.uuid.toLowerCase();
    if (ids.has(uuid)) throw new Error("RESEARCH_MARKETAUX_DUPLICATE_UUID"); ids.add(uuid);
    const entities = item.entities.map(object);
    const matched = entities.filter(e => e.symbol === config.entity.symbol && e.name === config.entity.name && e.country === config.entity.country && e.type === config.entity.type && e.exchange === config.entity.exchange);
    if (matched.length !== 1) throw new Error("RESEARCH_MARKETAUX_ENTITY_MISMATCH");
    const published = timestamp(item.published_at);
    if (published.micros < start - 1_000_000n || published.micros > end + 1_000_000n) throw new Error("RESEARCH_MARKETAUX_PUBLICATION_OUTSIDE_QUERY");
    return { uuid, title: item.title, url: item.url, publishedAt: published.canonical, originalPublishedAt: published.original,
      entity: { ...config.entity }, inWindow: published.micros >= start && published.micros <= end };
  });
  return { found, returned, limit: config.pageSize, page: request.page, records };
}

export function marketauxRecordSetHash(records: MarketauxNewsRecord[]): string {
  const sorted = [...records].sort((a, b) => a.uuid.localeCompare(b.uuid));
  if (new Set(sorted.map(record => record.uuid)).size !== sorted.length) throw new Error("RESEARCH_MARKETAUX_DUPLICATE_UUID");
  return researchHash(sorted.map(({ uuid, title, url, originalPublishedAt, entity }) => ({ uuid, title, url, originalPublishedAt, entity })));
}
