export interface MarketNewsItem {
  headline: string;
  summary: string;
  source?: string;
  url?: string;
  publishedAt?: string;
  sentimentScore?: number;
  matchScore?: number;
}

interface MarketAuxClientOptions {
  apiKey?: string;
  baseUrl: string;
  timeoutMs: number;
}

interface MarketAuxEntity {
  symbol?: string;
  sentiment_score?: number;
  match_score?: number;
}

interface MarketAuxRawNews {
  title?: string;
  description?: string;
  snippet?: string;
  source?: string;
  url?: string;
  published_at?: string;
  entities?: MarketAuxEntity[];
}

export class MarketAuxClient {
  constructor(private readonly options: MarketAuxClientOptions) {}

  isConfigured(): boolean {
    return Boolean(this.options.apiKey);
  }

  async getNewsForSymbol(symbol: string, windowHours: number, maxItems: number): Promise<MarketNewsItem[]> {
    if (!this.options.apiKey) {
      throw new Error('LLM_AGENT_MARKETAUX_API_KEY is not configured');
    }

    const url = new URL(this.options.baseUrl);
    url.searchParams.set('api_token', this.options.apiKey);
    url.searchParams.set('symbols', symbol.toUpperCase());
    url.searchParams.set('filter_entities', 'true');
    url.searchParams.set('must_have_entities', 'true');
    url.searchParams.set('limit', String(Math.max(1, Math.min(maxItems, 50))));
    url.searchParams.set('published_after', formatMarketAuxDate(new Date(Date.now() - windowHours * 60 * 60 * 1000)));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json'
        }
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`MarketAux news error: ${response.status} ${response.statusText}: ${text}`);
      }

      const payload = (await response.json()) as unknown;
      const rawItems = this.extractItems(payload);
      return rawItems
        .map((item) => this.mapNews(item, symbol))
        .filter((item): item is MarketNewsItem => item !== null)
        .slice(0, maxItems);
    } finally {
      clearTimeout(timeout);
    }
  }

  private extractItems(payload: unknown): MarketAuxRawNews[] {
    if (Array.isArray(payload)) {
      return payload as MarketAuxRawNews[];
    }

    if (payload && typeof payload === 'object') {
      const obj = payload as Record<string, unknown>;
      if (Array.isArray(obj.data)) return obj.data as MarketAuxRawNews[];
      if (Array.isArray(obj.news)) return obj.news as MarketAuxRawNews[];
    }

    return [];
  }

  private mapNews(item: MarketAuxRawNews, symbol: string): MarketNewsItem | null {
    const headline = String(item.title ?? '').trim();
    if (!headline) return null;

    const summary = String(item.description ?? item.snippet ?? '').trim();
    const matchedEntity = (item.entities ?? []).find((entity) => entity.symbol?.toUpperCase() === symbol.toUpperCase());

    return {
      headline,
      summary,
      source: item.source,
      url: item.url,
      publishedAt: item.published_at,
      sentimentScore: matchedEntity?.sentiment_score,
      matchScore: matchedEntity?.match_score
    };
  }
}

function formatMarketAuxDate(date: Date): string {
  return date.toISOString().slice(0, 19);
}
