import { ResearchSourceFailure, researchHash, safeResearchUrl, type MarketauxEntity, type MarketauxNewsConfig, type MarketauxRequest, type ResearchNewsV2 } from "@ikbr/shared/instrument-research";

export interface MarketauxNewsRecord { uuid: string; title: string; url: string; publishedAt: string; originalPublishedAt: string; entity: MarketauxEntity; inWindow: boolean; enrichment?: { description: string | null; snippet: string | null; providerSentiment: ResearchNewsV2["providerSentiment"] } }
export interface MarketauxPage { found: number; returned: number; limit: number; page: number; records: MarketauxNewsRecord[] }
function invalid(constraint: string): never {
  const cause = Object.assign(new Error(`Local Marketaux payload validation; constraint=${constraint}`), { name: "MarketauxPayloadValidationError" });
  throw new ResearchSourceFailure("RESEARCH_MARKETAUX_PAYLOAD_INVALID", cause);
}
function object(value: unknown, field: "root" | "meta" | "article" | "article.entity"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${field}.object`);
  return value as Record<string, unknown>;
}

function timestamp(value: unknown): { micros: bigint; canonical: string; original: string } {
  if (typeof value !== "string") invalid("published_at.string");
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  if (!match) invalid("published_at.utc_format");
  const base = Date.parse(match[1] + "Z");
  if (!Number.isFinite(base) || new Date(base).toISOString().slice(0, 19) !== match[1]) invalid("published_at.calendar_date");
  const micros = BigInt(base) * 1000n + BigInt((match[2] ?? "").padEnd(6, "0"));
  return { micros, canonical: new Date(Number(micros / 1000n)).toISOString(), original: value };
}

function optionalText(value: unknown, field: "description" | "snippet"): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") invalid(`${field}.string`);
  if (value.length > 8000) invalid(`${field}.max_length`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value)) invalid(`${field}.control_characters`);
  return value;
}

function enrichment(item: Record<string, unknown>, sentiment: unknown): NonNullable<MarketauxNewsRecord["enrichment"]> {
  let providerSentiment: ResearchNewsV2["providerSentiment"];
  if (sentiment === undefined || sentiment === null) providerSentiment = { status: "NOT_PROVIDED" };
  else if (typeof sentiment === "number" && Number.isFinite(sentiment) && sentiment >= -1 && sentiment <= 1) providerSentiment = { status: "PROVIDED", score: sentiment };
  else return invalid("matched_entity.sentiment_score.finite_unit_range");
  return { description: optionalText(item.description, "description"), snippet: optionalText(item.snippet, "snippet"), providerSentiment };
}

export function parseMarketauxPage(input: unknown, config: MarketauxNewsConfig, request: MarketauxRequest, schemaVersion: 1 | 2 = 1): MarketauxPage {
  const root = object(input, "root"), meta = object(root.meta, "meta");
  if (Object.hasOwn(root, "error") || Object.hasOwn(root, "errors")) invalid("root.provider_error_envelope");
  if (!Array.isArray(root.data)) invalid("data.array");
  for (const key of ["found", "returned", "limit", "page"] as const) if (!Number.isSafeInteger(meta[key]) || Number(meta[key]) < 0) invalid(`meta.${key}.nonnegative_safe_integer`);
  const found = meta.found as number, returned = meta.returned as number;
  const pages = Math.max(1, Math.ceil(found / config.pageSize));
  if (found > config.maxArticles || found > 20_000 || pages > config.maxPagesPerPass || pages * config.pageSize > 20_000) {
    const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
    const details = [`providerReportedFound=${found}`];
    const values: [string, unknown][] = [["pageSize", config.pageSize], ["requiredPages", positive(config.pageSize) ? pages : undefined],
      ["maxPagesPerPass", config.maxPagesPerPass], ["maxArticles", config.maxArticles],
      ["pass", request.pass === 1 || request.pass === 2 ? request.pass : undefined], ["page", request.page]];
    for (const [key, value] of values) if (positive(value)) details.push(`${key}=${value}`);
    const exceeded: string[] = [];
    if (positive(config.maxArticles) && found > config.maxArticles) exceeded.push("maxArticles");
    if (found > 20_000) exceeded.push("providerResultBound");
    if (positive(config.pageSize) && positive(config.maxPagesPerPass) && pages > config.maxPagesPerPass) exceeded.push("maxPagesPerPass");
    if (positive(config.pageSize) && positive(pages) && pages * config.pageSize > 20_000) exceeded.push("expandedPageBound");
    if (exceeded.length) details.push(`exceeded=${exceeded.join(",")}`);
    const cause = Object.assign(new Error(`Local Marketaux capacity validation; ${details.join("; ")}`), { name: "MarketauxCapacityLimitError" });
    throw new ResearchSourceFailure("RESEARCH_MARKETAUX_RESULT_LIMIT", cause);
  }
  if (meta.limit !== config.pageSize) invalid("meta.limit.request_match");
  if (meta.page !== request.page) invalid("meta.page.request_match");
  if (request.page > pages) invalid("request.page.result_bound");
  if (returned !== root.data.length) invalid("meta.returned.data_length");
  if (returned !== Math.min(config.pageSize, Math.max(0, found - (request.page - 1) * config.pageSize))) invalid("meta.returned.page_cardinality");
  const start = BigInt(Date.parse(request.windowStart)) * 1000n, end = BigInt(Date.parse(request.asOf)) * 1000n;
  const ids = new Set<string>();
  const records = root.data.map(raw => {
    const item = object(raw, "article");
    if (typeof item.uuid !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(item.uuid)) invalid("article.uuid.format");
    if (typeof item.title !== "string") invalid("article.title.string");
    if (!item.title.trim()) invalid("article.title.nonempty");
    if (item.title.length > 1000) invalid("article.title.max_length");
    if (/[\u0000-\u001f\u007f]/.test(item.title)) invalid("article.title.control_characters");
    if (!safeResearchUrl(item.url)) invalid("article.url.safe_public_url");
    if (!Array.isArray(item.entities)) invalid("article.entities.array");
    if (item.similar !== undefined && (!Array.isArray(item.similar) || item.similar.length !== 0)) invalid("article.similar.empty_array");
    const uuid = item.uuid.toLowerCase();
    if (ids.has(uuid)) throw new Error("RESEARCH_MARKETAUX_DUPLICATE_UUID"); ids.add(uuid);
    const entities = item.entities.map(value => object(value, "article.entity"));
    const matched = entities.filter(e => e.symbol === config.entity.symbol && e.name === config.entity.name && e.country === config.entity.country && e.type === config.entity.type && e.exchange === config.entity.exchange);
    if (matched.length !== 1) throw new Error("RESEARCH_MARKETAUX_ENTITY_MISMATCH");
    const published = timestamp(item.published_at);
    if (published.micros < start - 1_000_000n || published.micros > end + 1_000_000n) throw new Error("RESEARCH_MARKETAUX_PUBLICATION_OUTSIDE_QUERY");
    return { uuid, title: item.title, url: item.url, publishedAt: published.canonical, originalPublishedAt: published.original,
      entity: { ...config.entity }, inWindow: published.micros >= start && published.micros <= end,
      ...(schemaVersion === 2 ? { enrichment: enrichment(item, matched[0].sentiment_score) } : {}) };
  });
  return { found, returned, limit: config.pageSize, page: request.page, records };
}

export function marketauxRecordSetHash(records: MarketauxNewsRecord[]): string {
  const sorted = [...records].sort((a, b) => a.uuid.localeCompare(b.uuid));
  if (new Set(sorted.map(record => record.uuid)).size !== sorted.length) throw new Error("RESEARCH_MARKETAUX_DUPLICATE_UUID");
  return researchHash(sorted.map(({ uuid, title, url, originalPublishedAt, entity, enrichment }) => ({ uuid, title, url, originalPublishedAt, entity, ...(enrichment === undefined ? {} : { enrichment }) })));
}
