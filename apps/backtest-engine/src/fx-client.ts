import type { BacktestFxRate } from './types.js';

interface FrankfurterSeriesResponse {
  date?: string;
  base?: string;
  quote?: string;
  rate?: number;
  rates?: Record<string, Record<string, number>>;
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export class FrankfurterFxClient {
  constructor(private readonly source = 'frankfurter_ecb') {}

  async fetchDailyRatesToBase(input: {
    quoteCurrency: string;
    baseCurrency: string;
    dateFrom: Date;
    dateTo: Date;
  }): Promise<BacktestFxRate[]> {
    const quoteCurrency = input.quoteCurrency.trim().toUpperCase();
    const baseCurrency = input.baseCurrency.trim().toUpperCase();
    if (!quoteCurrency || !baseCurrency || quoteCurrency === baseCurrency) return [];

    const from = dateOnly(input.dateFrom);
    const to = dateOnly(input.dateTo);
    const url = new URL('https://api.frankfurter.dev/v2/rates');
    url.searchParams.set('from', from);
    url.searchParams.set('to', to);
    url.searchParams.set('base', quoteCurrency);
    url.searchParams.set('quotes', baseCurrency);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`FX fetch failed for ${quoteCurrency}->${baseCurrency}: HTTP ${response.status}`);
    }

    const payload = (await response.json()) as FrankfurterSeriesResponse | FrankfurterSeriesResponse[];
    const rows = Array.isArray(payload) ? payload : payload.rates
      ? Object.entries(payload.rates).map(([date, byCurrency]) => ({
          date,
          rate: Number(byCurrency[baseCurrency])
        }))
      : [{ date: payload.date, rate: payload.rate }];

    return rows
      .map((row) => ({
        date: String(row.date ?? ''),
        baseCurrency,
        quoteCurrency,
        rateToBase: Number(row.rate),
        source: this.source
      }))
      .filter((rate) => Number.isFinite(rate.rateToBase) && rate.rateToBase > 0);
  }
}
