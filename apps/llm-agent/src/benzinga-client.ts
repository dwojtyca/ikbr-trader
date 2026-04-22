export interface MarketNewsItem {
  headline: string;
  summary: string;
  source?: string;
  url?: string;
  publishedAt?: string;
}

interface BenzingaClientOptions {
  apiKey?: string;
  baseUrl: string;
  timeoutMs: number;
}

interface BenzingaRawNews {
  title?: string;
  headline?: string;
  teaser?: string;
  description?: string;
  body?: string;
  created?: string;
  created_at?: string;
  updated?: string;
  updated_at?: string;
  published?: string;
  published_at?: string;
  url?: string;
  source?: string;
}

export class BenzingaClient {
  constructor(private readonly options: BenzingaClientOptions) {}

  isConfigured(): boolean {
    return Boolean(this.options.apiKey);
  }

  async getNewsForSymbol(symbol: string, windowHours: number, maxItems: number): Promise<MarketNewsItem[]> {
    if (!this.options.apiKey) {
      throw new Error('BENZINGA_API_KEY is not configured');
    }

    const url = new URL(this.options.baseUrl);
    url.searchParams.set('token', this.options.apiKey);
    // Benzinga News API uses `tickers` (CSV list, max 50 symbols).
    url.searchParams.set('tickers', symbol.toUpperCase());
    url.searchParams.set('displayOutput', 'full');
    // pageSize supports up to 100 for this endpoint.
    url.searchParams.set('pageSize', String(Math.max(1, Math.min(maxItems, 100))));
    // Supported sort fields: id|created|updated with direction.
    url.searchParams.set('sort', 'updated:desc');

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
        throw new Error(`Benzinga news error: ${response.status} ${response.statusText}: ${text}`);
      }

      const payload = (await response.json()) as unknown;
      const rawItems = this.extractItems(payload);
      const thresholdTs = Date.now() - windowHours * 60 * 60 * 1000;

      const mapped = rawItems
        .map((item) => this.mapNews(item))
        .filter((item): item is MarketNewsItem => item !== null)
        .filter((item) => {
          if (!item.publishedAt) return true;
          const ts = new Date(item.publishedAt).getTime();
          return Number.isFinite(ts) ? ts >= thresholdTs : true;
        });

      return mapped.slice(0, maxItems);
    } finally {
      clearTimeout(timeout);
    }
  }

  private extractItems(payload: unknown): BenzingaRawNews[] {
    if (Array.isArray(payload)) {
      return payload as BenzingaRawNews[];
    }

    if (payload && typeof payload === 'object') {
      const obj = payload as Record<string, unknown>;
      if (Array.isArray(obj.data)) return obj.data as BenzingaRawNews[];
      if (Array.isArray(obj.news)) return obj.news as BenzingaRawNews[];
      if (Array.isArray(obj.items)) return obj.items as BenzingaRawNews[];
    }

    return [];
  }

  private mapNews(item: BenzingaRawNews): MarketNewsItem | null {
    const headline = String(item.title ?? item.headline ?? '').trim();
    if (!headline) return null;

    const summary = String(item.teaser ?? item.description ?? item.body ?? '').trim();
    const publishedAt = item.published_at ?? item.published ?? item.created_at ?? item.created ?? item.updated_at ?? item.updated;

    return {
      headline,
      summary,
      source: item.source,
      url: item.url,
      publishedAt
    };
  }
}
