import { ResearchSourceFailure, researchHash, researchReferenceUrlRejection, type ResearchUrlRejection, type MarketauxEntity, type MarketauxNewsConfig, type MarketauxRequest, type ResearchNewsV2 } from "@ikbr/shared/instrument-research";

export interface MarketauxNewsRecord { uuid: string; title: string; url: string; publishedAt: string; originalPublishedAt: string; entity: MarketauxEntity; inWindow: boolean; enrichment?: { description: string | null; snippet: string | null; providerSentiment: ResearchNewsV2["providerSentiment"] } }
export interface MarketauxPage { found: number; returned: number; limit: number; page: number; records: MarketauxNewsRecord[] }
interface PayloadLocation { pass?: unknown; page?: unknown; recordIndex?: number; entityIndex?: number }
function invalid(constraint: string, location: PayloadLocation = {}, urlPredicate?: ResearchUrlRejection): never {
  const details = [`constraint=${constraint}`];
  if (urlPredicate !== undefined) details.push(`urlPredicate=${urlPredicate}`);
  if (location.pass === 1 || location.pass === 2) details.push(`pass=${location.pass}`);
  for (const key of ["page", "recordIndex", "entityIndex"] as const) {
    const value = location[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= (key === "page" ? 1 : 0)) details.push(`${key}=${value}`);
  }
  const cause = Object.assign(new Error(`Local Marketaux payload validation; ${details.join("; ")}`), { name: "MarketauxPayloadValidationError" });
  throw new ResearchSourceFailure("RESEARCH_MARKETAUX_PAYLOAD_INVALID", cause);
}
function object(value: unknown, field: "root" | "meta" | "article" | "article.entity", location: PayloadLocation): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${field}.object`, location);
  return value as Record<string, unknown>;
}

function timestamp(value: unknown, location: PayloadLocation): { micros: bigint; canonical: string; original: string } {
  if (typeof value !== "string") invalid("published_at.string", location);
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  if (!match) invalid("published_at.utc_format", location);
  const base = Date.parse(match[1] + "Z");
  if (!Number.isFinite(base) || new Date(base).toISOString().slice(0, 19) !== match[1]) invalid("published_at.calendar_date", location);
  const micros = BigInt(base) * 1000n + BigInt((match[2] ?? "").padEnd(6, "0"));
  return { micros, canonical: new Date(Number(micros / 1000n)).toISOString(), original: value };
}

function optionalText(value: unknown, field: "description" | "snippet", location: PayloadLocation): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") invalid(`${field}.string`, location);
  if (value.length > 8000) invalid(`${field}.max_length`, location);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value)) invalid(`${field}.control_characters`, location);
  return value;
}

function enrichment(item: Record<string, unknown>, sentiment: unknown, location: PayloadLocation, entityIndex: number): NonNullable<MarketauxNewsRecord["enrichment"]> {
  let providerSentiment: ResearchNewsV2["providerSentiment"];
  if (sentiment === undefined || sentiment === null) providerSentiment = { status: "NOT_PROVIDED" };
  else if (typeof sentiment === "number" && Number.isFinite(sentiment) && sentiment >= -1 && sentiment <= 1) providerSentiment = { status: "PROVIDED", score: sentiment };
  else return invalid("matched_entity.sentiment_score.finite_unit_range", { ...location, entityIndex });
  return { description: optionalText(item.description, "description", location), snippet: optionalText(item.snippet, "snippet", location), providerSentiment };
}

export function parseMarketauxPage(input: unknown, config: MarketauxNewsConfig, request: MarketauxRequest, schemaVersion: 1 | 2 = 1): MarketauxPage {
  const location: PayloadLocation = { pass: request.pass, page: request.page };
  const reject: (constraint: string) => never = constraint => invalid(constraint, location);
  const root = object(input, "root", location), meta = object(root.meta, "meta", location);
  if (Object.hasOwn(root, "error") || Object.hasOwn(root, "errors")) reject("root.provider_error_envelope");
  if (!Array.isArray(root.data)) reject("data.array");
  for (const key of ["found", "returned", "limit", "page"] as const) if (!Number.isSafeInteger(meta[key]) || Number(meta[key]) < 0) reject(`meta.${key}.nonnegative_safe_integer`);
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
  if (meta.limit !== config.pageSize) reject("meta.limit.request_match");
  if (meta.page !== request.page) reject("meta.page.request_match");
  if (request.page > pages) reject("request.page.result_bound");
  if (returned !== root.data.length) reject("meta.returned.data_length");
  if (returned !== Math.min(config.pageSize, Math.max(0, found - (request.page - 1) * config.pageSize))) reject("meta.returned.page_cardinality");
  const start = BigInt(Date.parse(request.windowStart)) * 1000n, end = BigInt(Date.parse(request.asOf)) * 1000n;
  const ids = new Set<string>();
  const records = root.data.map((raw, recordIndex) => {
    const recordLocation = { ...location, recordIndex };
    const reject: (constraint: string, urlPredicate?: ResearchUrlRejection) => never = (constraint, urlPredicate) => invalid(constraint, recordLocation, urlPredicate);
    const item = object(raw, "article", recordLocation);
    if (typeof item.uuid !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(item.uuid)) reject("article.uuid.format");
    if (typeof item.title !== "string") reject("article.title.string");
    if (!item.title.trim()) reject("article.title.nonempty");
    if (item.title.length > 1000) reject("article.title.max_length");
    if (/[\u0000-\u001f\u007f]/.test(item.title)) reject("article.title.control_characters");
    const urlRejection = researchReferenceUrlRejection(item.url);
    if (urlRejection !== null) reject("article.url.safe_public_url", urlRejection);
    if (!Array.isArray(item.entities)) reject("article.entities.array");
    if (item.similar !== undefined && (!Array.isArray(item.similar) || item.similar.length !== 0)) reject("article.similar.empty_array");
    const uuid = item.uuid.toLowerCase();
    if (ids.has(uuid)) throw new Error("RESEARCH_MARKETAUX_DUPLICATE_UUID"); ids.add(uuid);
    const entities = item.entities.map((value, entityIndex) => object(value, "article.entity", { ...recordLocation, entityIndex }));
    const matched = entities.filter(e => e.symbol === config.entity.symbol && e.name === config.entity.name && e.country === config.entity.country && e.type === config.entity.type && e.exchange === config.entity.exchange);
    if (matched.length !== 1) throw new Error("RESEARCH_MARKETAUX_ENTITY_MISMATCH");
    const published = timestamp(item.published_at, recordLocation);
    if (published.micros < start - 1_000_000n || published.micros > end + 1_000_000n) throw new Error("RESEARCH_MARKETAUX_PUBLICATION_OUTSIDE_QUERY");
    return { uuid, title: item.title, url: item.url as string, publishedAt: published.canonical, originalPublishedAt: published.original,
      entity: { ...config.entity }, inWindow: published.micros >= start && published.micros <= end,
      ...(schemaVersion === 2 ? { enrichment: enrichment(item, matched[0].sentiment_score, recordLocation, entities.indexOf(matched[0])) } : {}) };
  });
  return { found, returned, limit: config.pageSize, page: request.page, records };
}

export function marketauxRecordSetHash(records: MarketauxNewsRecord[]): string {
  const sorted = [...records].sort((a, b) => a.uuid.localeCompare(b.uuid));
  if (new Set(sorted.map(record => record.uuid)).size !== sorted.length) throw new Error("RESEARCH_MARKETAUX_DUPLICATE_UUID");
  return researchHash(sorted.map(({ uuid, title, url, originalPublishedAt, entity, enrichment }) => ({ uuid, title, url, originalPublishedAt, entity, ...(enrichment === undefined ? {} : { enrichment }) })));
}
