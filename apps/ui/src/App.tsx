import { useEffect, useMemo, useRef, useState } from 'react';

type HealthResponse = { ok: boolean; twsConnected?: boolean };

type MarketState = {
  conid: string;
  symbol: string;
  lastPrice: number;
  bid?: number;
  ask?: number;
  spread?: number;
  ts: string;
};

type Candle = {
  conid: string;
  symbol: string;
  timeframe: '1m' | '5m' | '1h';
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type WatchlistItem = {
  symbol: string;
  conid: string | null;
  subscribed: boolean;
  marketState: MarketState | null;
  latestCandle1m: Candle | null;
};

type WatchlistResponse = {
  connected: boolean;
  bootstrapped: boolean;
  lastBootstrapAt: string | null;
  watchlist: WatchlistItem[];
};

type Order = {
  id?: number;
  instrument: string;
  conid?: string;
  side: 'BUY' | 'SELL' | 'HOLD';
  orderType: 'MKT' | 'LMT';
  quantity: number;
  entry?: number;
  stop?: number;
  takeProfit?: number;
  reason: string;
  confidence: number;
  timestamp: string;
  riskCheckStatus: 'PASS' | 'REJECT';
  status: 'PROPOSED' | 'REJECTED' | 'SUBMITTED' | 'FILLED' | 'CANCELLED';
  brokerOrderId?: string;
  executionAccountId?: string;
  executionMessage?: string;
  lastError?: string;
};

type SignalOrder = {
  id: number;
  order: Omit<Order, 'id'>;
};

type OrderFilters = {
  instrument: string;
  side: string;
  type: string;
  qty: string;
  status: string;
  risk: string;
};

type AccountMetricSet = {
  netLiquidation?: number;
  totalCashValue?: number;
  settledCash?: number;
  buyingPower?: number;
  availableFunds?: number;
  excessLiquidity?: number;
  equityWithLoanValue?: number;
  grossPositionValue?: number;
  initMarginReq?: number;
  maintMarginReq?: number;
  unrealizedPnL?: number;
  realizedPnL?: number;
  cushion?: number;
};

type AccountPositionSnapshot = {
  conid?: string;
  symbol: string;
  secType?: string;
  exchange?: string;
  currency?: string;
  position: number;
  marketPrice?: number;
  marketValue?: number;
  averageCost?: number;
  unrealizedPnL?: number;
  realizedPnL?: number;
};

type AccountSummaryResponse = {
  source: 'cache' | 'live';
  accountId: string;
  accounts: string[];
  retrievedAt: string;
  accountTime?: string;
  metrics: AccountMetricSet;
  totals: {
    positionsCount: number;
    longExposure: number;
    shortExposure: number;
    grossExposure: number;
    netExposure: number;
    unrealizedPnL: number;
    realizedPnL: number;
  };
  positions: AccountPositionSnapshot[];
};

async function requestJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${body}`);
  }
  return response.json() as Promise<T>;
}

function formatNum(value?: number | null, digits = 2): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '-';
  return value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function formatTs(value?: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatPct(value?: number | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '-';
  return `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}%`;
}

export function App() {
  const ordersPollInFlightRef = useRef(false);
  const watchlistPollInFlightRef = useRef(false);
  const healthPollInFlightRef = useRef(false);
  const accountPollInFlightRef = useRef(false);

  const [ingestionHealth, setIngestionHealth] = useState<HealthResponse | null>(null);
  const [signalHealth, setSignalHealth] = useState<HealthResponse | null>(null);
  const [executionHealth, setExecutionHealth] = useState<HealthResponse | null>(null);

  const [watchlist, setWatchlist] = useState<WatchlistResponse | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [accountSummary, setAccountSummary] = useState<AccountSummaryResponse | null>(null);
  const [orderFilters, setOrderFilters] = useState<OrderFilters>({
    instrument: '',
    side: '',
    type: '',
    qty: '',
    status: '',
    risk: ''
  });

  const [loadingWatchlist, setLoadingWatchlist] = useState(false);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [loadingAccount, setLoadingAccount] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [dryRunExecute, setDryRunExecute] = useState(true);

  const [lastAction, setLastAction] = useState<string>('Ready');
  const [lastError, setLastError] = useState<string | null>(null);

  const orderFiltersRef = useRef(orderFilters);

  const proposedCount = useMemo(() => orders.filter((o) => o.status === 'PROPOSED').length, [orders]);
  const hasOrderFilters = useMemo(
    () => Object.values(orderFilters).some((value) => value.trim() !== ''),
    [orderFilters]
  );

  function buildOrdersQuery(filters: OrderFilters): string {
    const params = new URLSearchParams();
    params.set('limit', '50');

    const instrument = filters.instrument.trim();
    if (instrument) params.set('instrument', instrument);
    if (filters.side) params.set('side', filters.side);
    if (filters.type) params.set('type', filters.type);
    if (filters.status) params.set('status', filters.status);
    if (filters.risk) params.set('risk', filters.risk);

    const qtyRaw = filters.qty.trim();
    if (qtyRaw && /^-?\d+(\.\d+)?$/.test(qtyRaw)) {
      params.set('qty', qtyRaw);
    }

    return `/api/execution/execution/orders?${params.toString()}`;
  }

  async function refreshHealth() {
    const [ing, sig, exe] = await Promise.all([
      requestJson<HealthResponse>('/api/ingestion/health').catch(() => ({ ok: false })),
      requestJson<HealthResponse>('/api/signal/health').catch(() => ({ ok: false })),
      requestJson<HealthResponse>('/api/execution/health').catch(() => ({ ok: false }))
    ]);

    setIngestionHealth(ing);
    setSignalHealth(sig);
    setExecutionHealth(exe);
  }

  async function refreshWatchlist(options?: { silent?: boolean }) {
    const silent = options?.silent ?? false;
    if (!silent) setLoadingWatchlist(true);
    try {
      const data = await requestJson<WatchlistResponse>('/api/ingestion/watchlist');
      setWatchlist(data);
    } finally {
      if (!silent) setLoadingWatchlist(false);
    }
  }

  async function refreshOrders(options?: { silent?: boolean; filters?: OrderFilters }) {
    const silent = options?.silent ?? false;
    const filters = options?.filters ?? orderFiltersRef.current;
    if (!silent) setLoadingOrders(true);
    try {
      const data = await requestJson<Order[]>(buildOrdersQuery(filters));
      setOrders(data);
    } finally {
      if (!silent) setLoadingOrders(false);
    }
  }

  async function refreshAccount(options?: { silent?: boolean }) {
    const silent = options?.silent ?? false;
    if (!silent) setLoadingAccount(true);
    try {
      const data = await requestJson<AccountSummaryResponse>('/api/execution/execution/account/summary');
      setAccountSummary(data);
    } catch {
      if (!silent) setAccountSummary(null);
    } finally {
      if (!silent) setLoadingAccount(false);
    }
  }

  async function refreshAll() {
    setLastError(null);
    try {
      await Promise.all([refreshHealth(), refreshWatchlist(), refreshOrders(), refreshAccount()]);
      setLastAction(`Refreshed at ${new Date().toLocaleTimeString()}`);
    } catch (error) {
      setLastError((error as Error).message);
      setLastAction('Refresh failed');
    }
  }

  async function handleAction(name: string, fn: () => Promise<unknown>) {
    setBusyAction(name);
    setLastError(null);
    try {
      await fn();
      await refreshAll();
      setLastAction(`${name} completed at ${new Date().toLocaleTimeString()}`);
    } catch (error) {
      setLastError((error as Error).message);
      setLastAction(`${name} failed`);
    } finally {
      setBusyAction(null);
    }
  }

  async function bootstrapIngestion() {
    await requestJson('/api/ingestion/bootstrap', { method: 'POST' });
  }

  async function runSignalsOnce() {
    const result = await requestJson<{ generated: number; results: SignalOrder[] }>('/api/signal/signals/run-once', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    setLastAction(`signals/run-once generated ${result.generated}`);
  }

  async function bootstrapExecution() {
    await requestJson('/api/execution/execution/bootstrap', { method: 'POST' });
  }

  async function executeOrder(orderId: number) {
    await requestJson(`/api/execution/execution/execute-proposed/${orderId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: dryRunExecute })
    });
  }

  async function executeAllProposed() {
    const proposed = orders.filter((o) => o.status === 'PROPOSED' && o.id !== undefined);
    for (const order of proposed) {
      await executeOrder(order.id as number);
    }
  }

  useEffect(() => {
    orderFiltersRef.current = orderFilters;
  }, [orderFilters]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      void refreshOrders({ filters: orderFilters }).catch((error) => {
        setLastError((error as Error).message);
      });
    }, 250);

    return () => clearTimeout(timeout);
  }, [orderFilters]);

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (ordersPollInFlightRef.current) return;

      ordersPollInFlightRef.current = true;
      void refreshOrders({ silent: true })
        .catch(() => {})
        .finally(() => {
          ordersPollInFlightRef.current = false;
        });
    }, 3000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (watchlistPollInFlightRef.current) return;

      watchlistPollInFlightRef.current = true;
      void refreshWatchlist({ silent: true })
        .catch(() => {})
        .finally(() => {
          watchlistPollInFlightRef.current = false;
        });
    }, 10000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (healthPollInFlightRef.current || accountPollInFlightRef.current) return;

      healthPollInFlightRef.current = true;
      accountPollInFlightRef.current = true;

      void Promise.all([refreshHealth(), refreshAccount({ silent: true })])
        .catch(() => {})
        .finally(() => {
          healthPollInFlightRef.current = false;
          accountPollInFlightRef.current = false;
        });
    }, 10000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="app-shell">
      <header className="hero">
        <h1>IKBR Trader Console</h1>
        <p>Ingestion, signal engine i execution w jednym panelu operatorskim.</p>
      </header>

      <section className="panel controls">
        <div className="status-row">
          <StatusPill label="Ingestion" ok={Boolean(ingestionHealth?.ok)} extra={watchlist?.connected ? 'socket:on' : 'socket:off'} />
          <StatusPill label="Signal" ok={Boolean(signalHealth?.ok)} />
          <StatusPill label="Execution" ok={Boolean(executionHealth?.ok)} extra={executionHealth?.twsConnected ? 'tws:on' : 'tws:off'} />
          <StatusPill label="Proposed" ok={proposedCount > 0} extra={String(proposedCount)} />
        </div>

        <div className="action-grid">
          <button disabled={Boolean(busyAction)} onClick={() => void handleAction('Ingestion bootstrap', bootstrapIngestion)}>Ingestion Bootstrap</button>
          <button disabled={Boolean(busyAction)} onClick={() => void handleAction('Signals run-once', runSignalsOnce)}>Run Signals Once</button>
          <button disabled={Boolean(busyAction)} onClick={() => void handleAction('Execution bootstrap', bootstrapExecution)}>Execution Bootstrap</button>
          <button disabled={Boolean(busyAction)} onClick={() => void handleAction('Refresh', refreshAll)}>Refresh</button>
        </div>

        <div className="action-grid compact">
          <label className="toggle">
            <input type="checkbox" checked={dryRunExecute} onChange={(e) => setDryRunExecute(e.target.checked)} />
            Execute in dry-run
          </label>
          <button disabled={Boolean(busyAction) || proposedCount === 0} onClick={() => void handleAction('Execute all proposed', executeAllProposed)}>
            Execute All Proposed
          </button>
        </div>

        <div className="meta-row">
          <span>{busyAction ? `Working: ${busyAction}` : lastAction}</span>
          {lastError ? <span className="error">{lastError}</span> : null}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Account</h2>
          <span>
            {loadingAccount ? 'loading...' : accountSummary ? `${accountSummary.accountId} (${accountSummary.source})` : 'not available'}
          </span>
        </div>

        {accountSummary ? (
          <>
            <div className="metrics-grid">
              <MetricCard label="Net Liquidation" value={formatNum(accountSummary.metrics.netLiquidation)} />
              <MetricCard label="Total Cash" value={formatNum(accountSummary.metrics.totalCashValue)} />
              <MetricCard label="Buying Power" value={formatNum(accountSummary.metrics.buyingPower)} />
              <MetricCard label="Available Funds" value={formatNum(accountSummary.metrics.availableFunds)} />
              <MetricCard label="Unrealized PnL" value={formatNum(accountSummary.totals.unrealizedPnL)} tone={accountSummary.totals.unrealizedPnL} />
              <MetricCard label="Realized PnL" value={formatNum(accountSummary.totals.realizedPnL)} tone={accountSummary.totals.realizedPnL} />
              <MetricCard label="Gross Exposure" value={formatNum(accountSummary.totals.grossExposure)} />
              <MetricCard label="Cushion" value={formatPct(accountSummary.metrics.cushion)} />
            </div>

            <div className="panel-head compact">
              <h3>Open Positions</h3>
              <span>
                {accountSummary.totals.positionsCount} positions, updated {formatTs(accountSummary.retrievedAt)}
              </span>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Conid</th>
                    <th>Qty</th>
                    <th>Price</th>
                    <th>Market Value</th>
                    <th>Avg Cost</th>
                    <th>Unrealized PnL</th>
                    <th>Realized PnL</th>
                    <th>Exchange</th>
                  </tr>
                </thead>
                <tbody>
                  {accountSummary.positions.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="muted">No open positions</td>
                    </tr>
                  ) : (
                    accountSummary.positions.map((position) => (
                      <tr key={`${position.conid ?? position.symbol}-${position.symbol}`}>
                        <td>{position.symbol}</td>
                        <td>{position.conid ?? '-'}</td>
                        <td>{formatNum(position.position, 0)}</td>
                        <td>{formatNum(position.marketPrice)}</td>
                        <td>{formatNum(position.marketValue)}</td>
                        <td>{formatNum(position.averageCost)}</td>
                        <td className={toToneClass(position.unrealizedPnL)}>{formatNum(position.unrealizedPnL)}</td>
                        <td className={toToneClass(position.realizedPnL)}>{formatNum(position.realizedPnL)}</td>
                        <td>{position.exchange ?? '-'}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="muted">Account summary unavailable. Run `Execution Bootstrap`, then click `Refresh`.</div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Watchlist</h2>
          <span>{loadingWatchlist ? 'loading...' : `items: ${watchlist?.watchlist.length ?? 0}`}</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Conid</th>
                <th>Subscribed</th>
                <th>Last</th>
                <th>Bid</th>
                <th>Ask</th>
                <th>Spread</th>
                <th>1m Close</th>
                <th>1m Vol</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {(watchlist?.watchlist ?? []).map((item) => (
                <tr key={item.symbol}>
                  <td>{item.symbol}</td>
                  <td>{item.conid ?? '-'}</td>
                  <td>{item.subscribed ? 'yes' : 'no'}</td>
                  <td>{formatNum(item.marketState?.lastPrice)}</td>
                  <td>{formatNum(item.marketState?.bid)}</td>
                  <td>{formatNum(item.marketState?.ask)}</td>
                  <td>{formatNum(item.marketState?.spread, 4)}</td>
                  <td>{formatNum(item.latestCandle1m?.close)}</td>
                  <td>{formatNum(item.latestCandle1m?.volume, 0)}</td>
                  <td>{formatTs(item.marketState?.ts ?? item.latestCandle1m?.ts ?? null)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Orders</h2>
          <span>{loadingOrders ? 'loading...' : `rows: ${orders.length}${hasOrderFilters ? ' (server filter)' : ''}`}</span>
        </div>
        <div className="order-filters">
          <input
            type="text"
            placeholder="Instrument"
            value={orderFilters.instrument}
            onChange={(e) => setOrderFilters((prev) => ({ ...prev, instrument: e.target.value }))}
          />
          <select value={orderFilters.side} onChange={(e) => setOrderFilters((prev) => ({ ...prev, side: e.target.value }))}>
            <option value="">Side: all</option>
            <option value="BUY">BUY</option>
            <option value="SELL">SELL</option>
            <option value="HOLD">HOLD</option>
          </select>
          <select value={orderFilters.type} onChange={(e) => setOrderFilters((prev) => ({ ...prev, type: e.target.value }))}>
            <option value="">Type: all</option>
            <option value="MKT">MKT</option>
            <option value="LMT">LMT</option>
          </select>
          <input
            type="text"
            inputMode="numeric"
            placeholder="Qty (exact)"
            value={orderFilters.qty}
            onChange={(e) => setOrderFilters((prev) => ({ ...prev, qty: e.target.value }))}
          />
          <select value={orderFilters.status} onChange={(e) => setOrderFilters((prev) => ({ ...prev, status: e.target.value }))}>
            <option value="">Status: all</option>
            <option value="PROPOSED">PROPOSED</option>
            <option value="REJECTED">REJECTED</option>
            <option value="SUBMITTED">SUBMITTED</option>
            <option value="FILLED">FILLED</option>
            <option value="CANCELLED">CANCELLED</option>
          </select>
          <select value={orderFilters.risk} onChange={(e) => setOrderFilters((prev) => ({ ...prev, risk: e.target.value }))}>
            <option value="">Risk: all</option>
            <option value="PASS">PASS</option>
            <option value="REJECT">REJECT</option>
          </select>
          <button
            type="button"
            disabled={!hasOrderFilters}
            onClick={() => setOrderFilters({ instrument: '', side: '', type: '', qty: '', status: '', risk: '' })}
          >
            Clear filters
          </button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Instrument</th>
                <th>Side</th>
                <th>Type</th>
                <th>Qty</th>
                <th>Status</th>
                <th>Risk</th>
                <th>Confidence</th>
                <th>Reason</th>
                <th>Broker</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {orders.length === 0 ? (
                <tr>
                  <td colSpan={11} className="muted">No orders match current filters</td>
                </tr>
              ) : (
                orders.map((order) => (
                  <tr key={`${order.id}-${order.timestamp}`}>
                    <td>{order.id ?? '-'}</td>
                    <td>{order.instrument}</td>
                    <td>{order.side}</td>
                    <td>{order.orderType}</td>
                    <td>{formatNum(order.quantity, 0)}</td>
                    <td>{order.status}</td>
                    <td>{order.riskCheckStatus}</td>
                    <td>{formatPct(order.confidence)}</td>
                    <td className="reason" title={order.reason}>{order.reason}</td>
                    <td>{order.brokerOrderId ?? '-'}</td>
                    <td>
                      {order.status === 'PROPOSED' && order.id !== undefined ? (
                        <button
                          disabled={Boolean(busyAction)}
                          onClick={() => void handleAction(`Execute order ${order.id}`, async () => executeOrder(order.id as number))}
                        >
                          Execute
                        </button>
                      ) : (
                        <span className="muted">-</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function StatusPill({ label, ok, extra }: { label: string; ok: boolean; extra?: string }) {
  return (
    <div className={`pill ${ok ? 'ok' : 'bad'}`}>
      <span>{label}</span>
      {extra ? <small>{extra}</small> : null}
    </div>
  );
}

function MetricCard({ label, value, tone }: { label: string; value: string; tone?: number }) {
  return (
    <div className="metric-card">
      <small>{label}</small>
      <strong className={toToneClass(tone)}>{value}</strong>
    </div>
  );
}

function toToneClass(value?: number): string {
  if (value === undefined || value === null || Number.isNaN(value) || value === 0) return '';
  return value > 0 ? 'positive' : 'negative';
}
