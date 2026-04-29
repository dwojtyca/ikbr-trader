import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { deriveOrderDiagnostics } from '@ikbr/shared';

type HealthResponse = {
  ok: boolean;
  twsConnected?: boolean;
  connected?: boolean;
  bootstrapped?: boolean;
  lastBootstrapAt?: string | null;
  lastTickAt?: string | null;
  lastCandleAt?: string | null;
  signalEventDriven?: boolean;
  lastSignalRunStartedAt?: string | null;
  lastSignalRunFinishedAt?: string | null;
  lastSignalRunSource?: 'manual' | 'candle' | 'startup' | null;
  lastSignalRunSymbols?: string[];
  lastSignalGeneratedCount?: number;
};

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
  displayName: string | null;
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
  status: 'PROPOSED' | 'REJECTED' | 'SUBMITTED' | 'FILLED' | 'CANCELLED' | 'SUPERSEDED' | 'EXPIRED';
  decisionSource?: 'signal' | 'llm' | 'user' | 'user_override';
  aiDecision?: 'EXECUTE' | 'REJECT';
  aiReason?: string;
  aiModel?: string;
  aiDecisionConfidence?: number;
  llmDecisionId?: number;
  sourceError?: string;
  brokerOrderId?: string;
  executionAccountId?: string;
  executionMessage?: string;
  lastError?: string;
  executionAttemptedAt?: string;
  executedAt?: string;
  createdAt?: string;
  indicators?: {
    regime?: 'trend' | 'range' | 'high_volatility';
    strategyProfile?: string;
  };
  brokerWarning?: string;
  cancelReasonCode?: 'submitted_timeout' | 'locate_held' | 'broker_not_ready' | 'broker_rejected' | 'manual_cancel' | 'unknown';
  cancelReasonDetail?: string;
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
  decisionSource: string;
  aiDecision: string;
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
  unrealizedPnLBase?: number;
  realizedPnLBase?: number;
};

type AccountSummaryResponse = {
  source: 'cache' | 'live';
  accountId: string;
  accounts: string[];
  retrievedAt: string;
  accountTime?: string;
  fxToBaseByCurrency?: Record<string, number>;
  metrics: AccountMetricSet;
  totals: {
    positionsCount: number;
    longExposure: number;
    shortExposure: number;
    grossExposure: number;
    netExposure: number;
    unrealizedPnL: number;
    realizedPnL: number;
    dailyRealizedPnL?: number;
    cumulativeRealizedPnL?: number;
  };
  diagnostics?: {
    cumulativeRealizedPnLComplete?: boolean;
    cumulativeRealizedPnLMissingCommissionReports?: number;
  };
  positions: AccountPositionSnapshot[];
};

type ReportOverview = {
  trades: number;
  wins: number;
  losses: number;
  open: number;
  winRate: number;
  avgPnlPct?: number;
  medianPnlPct?: number;
  avgConfidence?: number;
  takeProfitHits: number;
  stopHits: number;
};

type ReportAggregate = {
  key: string;
  trades: number;
  wins: number;
  losses: number;
  open: number;
  winRate: number;
  avgPnlPct?: number;
  medianPnlPct?: number;
  avgConfidence?: number;
  takeProfitHits: number;
  stopHits: number;
};

type ReportTrade = {
  orderId: number;
  instrument: string;
  strategy: string;
  side: 'BUY' | 'SELL';
  regime: string;
  confidence: number;
  pnlPct?: number;
  notes: string;
  executedAt: string;
};

type SignalReportResponse = {
  generatedAt: string;
  limit: number;
  overview: ReportOverview;
  bySymbol: ReportAggregate[];
  byStrategy: ReportAggregate[];
  bySide: ReportAggregate[];
  byRegime: ReportAggregate[];
  worstTrades: ReportTrade[];
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

function formatQty(value?: number | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '-';
  const abs = Math.abs(value);
  const digits = Math.abs(value - Math.trunc(value)) < 1e-9
    ? 0
    : abs >= 100
      ? 2
      : 4;
  return value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function formatTs(value?: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatAgeShort(value?: string | null): string {
  if (!value) return '-';
  const ts = new Date(value).getTime();
  if (Number.isNaN(ts)) return '-';
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return '0s';
  const totalSec = Math.floor(diffMs / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const totalHr = Math.floor(totalMin / 60);
  if (totalHr < 24) return `${totalHr}h`;
  return `${Math.floor(totalHr / 24)}d`;
}

function formatPct(value?: number | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '-';
  return `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}%`;
}

function formatPnlPct(value?: number | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '-';
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}%`;
}

function formatCancelReasonLabel(value?: Order['cancelReasonCode']): string {
  switch (value) {
    case 'submitted_timeout':
      return 'Submitted timeout';
    case 'locate_held':
      return 'Locate held';
    case 'broker_not_ready':
      return 'Broker delayed';
    case 'broker_rejected':
      return 'Broker rejected';
    case 'manual_cancel':
      return 'Manual cancel';
    case 'unknown':
      return 'Unknown';
    default:
      return '-';
  }
}

export function App() {
  const ordersPollInFlightRef = useRef(false);
  const watchlistPollInFlightRef = useRef(false);
  const healthPollInFlightRef = useRef(false);
  const accountPollInFlightRef = useRef(false);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const [ingestionHealth, setIngestionHealth] = useState<HealthResponse | null>(null);
  const [signalHealth, setSignalHealth] = useState<HealthResponse | null>(null);
  const [executionHealth, setExecutionHealth] = useState<HealthResponse | null>(null);

  const [watchlist, setWatchlist] = useState<WatchlistResponse | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [accountSummary, setAccountSummary] = useState<AccountSummaryResponse | null>(null);
  const [report, setReport] = useState<SignalReportResponse | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [watchlistExpanded, setWatchlistExpanded] = useState(false);
  const [orderFilters, setOrderFilters] = useState<OrderFilters>({
    instrument: '',
    side: '',
    type: '',
    qty: '',
    status: '',
    risk: '',
    decisionSource: '',
    aiDecision: ''
  });

  const [loadingWatchlist, setLoadingWatchlist] = useState(false);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [loadingAccount, setLoadingAccount] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [expandedAiOrderRows, setExpandedAiOrderRows] = useState<Record<string, boolean>>({});
  const [openActionMenuRowKey, setOpenActionMenuRowKey] = useState<string | null>(null);
  const [route, setRoute] = useState<'console' | 'report'>(() =>
    window.location.pathname === '/report' ? 'report' : 'console'
  );

  const [lastAction, setLastAction] = useState<string>('Ready');
  const [lastError, setLastError] = useState<string | null>(null);

  const orderFiltersRef = useRef(orderFilters);

  const proposedCount = useMemo(() => orders.filter((o) => o.status === 'PROPOSED').length, [orders]);
  const reportWeakestSide = useMemo(() => {
    const settledRows = (report?.bySide ?? []).filter((row) => row.trades > 0 && row.avgPnlPct !== undefined);
    return settledRows.sort((a, b) => (a.avgPnlPct ?? 0) - (b.avgPnlPct ?? 0))[0];
  }, [report?.bySide]);
  const reportWeakestStrategy = useMemo(() => {
    const settledRows = (report?.byStrategy ?? []).filter((row) => row.trades >= 2 && row.avgPnlPct !== undefined);
    return settledRows.sort((a, b) => (a.avgPnlPct ?? 0) - (b.avgPnlPct ?? 0))[0];
  }, [report?.byStrategy]);
  const reportWeakestSymbol = useMemo(() => {
    const settledRows = (report?.bySymbol ?? []).filter((row) => row.trades >= 2 && row.avgPnlPct !== undefined);
    return settledRows.sort((a, b) => (a.avgPnlPct ?? 0) - (b.avgPnlPct ?? 0))[0];
  }, [report?.bySymbol]);
  const hasOrderFilters = useMemo(
    () => Object.values(orderFilters).some((value) => value.trim() !== ''),
    [orderFilters]
  );
  const ingestionStatusExtra = useMemo(() => {
    const parts = [watchlist?.connected ? 'socket:on' : 'socket:off'];
    const tickAge = formatAgeShort(ingestionHealth?.lastTickAt ?? null);
    const candleAge = formatAgeShort(ingestionHealth?.lastCandleAt ?? null);
    if (tickAge !== '-') parts.push(`tick:${tickAge}`);
    if (candleAge !== '-') parts.push(`candle:${candleAge}`);
    return parts.join(' ');
  }, [ingestionHealth?.lastCandleAt, ingestionHealth?.lastTickAt, watchlist?.connected, nowTick]);
  const signalStatusExtra = useMemo(() => {
    const age = formatAgeShort(signalHealth?.lastSignalRunFinishedAt ?? null);
    const source = signalHealth?.lastSignalRunSource;
    const generated = signalHealth?.lastSignalGeneratedCount;
    const parts: string[] = [];
    if (source) parts.push(source);
    if (age !== '-') parts.push(age);
    if (generated !== undefined) parts.push(`gen:${generated}`);
    return parts.join(' ') || undefined;
  }, [signalHealth?.lastSignalGeneratedCount, signalHealth?.lastSignalRunFinishedAt, signalHealth?.lastSignalRunSource, nowTick]);
  const executionStatusExtra = useMemo(() => {
    const parts = [executionHealth?.twsConnected ? 'tws:on' : 'tws:off'];
    const snapshotAge = formatAgeShort(accountSummary?.retrievedAt ?? null);
    if (snapshotAge !== '-') parts.push(`snap:${snapshotAge}`);
    return parts.join(' ');
  }, [accountSummary?.retrievedAt, executionHealth?.twsConnected, nowTick]);

  function orderRowKey(order: Order): string {
    return `${order.id ?? 'no-id'}-${order.timestamp}`;
  }

  function toggleAiPanel(rowKey: string): void {
    setExpandedAiOrderRows((prev) => ({ ...prev, [rowKey]: !prev[rowKey] }));
  }

  function orderCreatedAt(order: Order): string {
    return order.createdAt ?? order.timestamp;
  }

  function orderUpdatedAt(order: Order): string {
    return order.executedAt ?? order.executionAttemptedAt ?? order.timestamp;
  }

  function buildOrdersQuery(filters: OrderFilters): string {
    const params = new URLSearchParams();
    params.set('limit', '50');

    const instrument = filters.instrument.trim();
    if (instrument) params.set('instrument', instrument);
    if (filters.side) params.set('side', filters.side);
    if (filters.type) params.set('type', filters.type);
    if (filters.status) params.set('status', filters.status);
    if (filters.risk) params.set('risk', filters.risk);
    if (filters.decisionSource) params.set('decisionSource', filters.decisionSource);
    if (filters.aiDecision) params.set('aiDecision', filters.aiDecision);

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
      setOrders(data.map((order) => ({ ...order, ...deriveOrderDiagnostics(order) })));
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

  async function refreshReport(options?: { silent?: boolean }) {
    const silent = options?.silent ?? false;
    if (!silent) setLoadingReport(true);
    setReportError(null);
    try {
      const data = await requestJson<SignalReportResponse>('/api/signal/signals/report?limit=300');
      setReport(data);
    } catch (error) {
      setReportError((error as Error).message);
      if (!silent) setReport(null);
    } finally {
      if (!silent) setLoadingReport(false);
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

  function navigate(nextRoute: 'console' | 'report'): void {
    const nextPath = nextRoute === 'report' ? '/report' : '/';
    if (window.location.pathname !== nextPath) {
      window.history.pushState({}, '', nextPath);
    }
    setRoute(nextRoute);
  }

  async function bootstrapIngestion() {
    await requestJson('/api/ingestion/bootstrap', { method: 'POST' });
  }

  async function stopIngestion() {
    await requestJson('/api/ingestion/stop', { method: 'POST' });
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

  async function executeOrder(orderId: number, overrideRejected = false) {
    await requestJson(`/api/execution/execution/execute-proposed/${orderId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        overrideRejected,
        actor: overrideRejected ? 'user_override' : 'user'
      })
    });
  }

  async function rejectOrder(orderId: number, reason: string) {
    await requestJson(`/api/execution/execution/reject-proposed/${orderId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reason,
        actor: 'user'
      })
    });
  }

  async function cancelOrder(orderId: number) {
    await requestJson(`/api/execution/execution/cancel-proposed/${orderId}`, {
      method: 'POST'
    });
  }

  async function executeAllProposed() {
    const proposed = orders.filter((o) => o.status === 'PROPOSED' && o.id !== undefined);
    for (const order of proposed) {
      await executeOrder(order.id as number);
    }
  }

  async function executePositionExit(position: AccountPositionSnapshot) {
    const qty = Math.abs(position.position);
    if (!(qty > 0)) return;

    const side: 'BUY' | 'SELL' = position.position > 0 ? 'SELL' : 'BUY';
    const positionEffect: 'CLOSE_OR_REDUCE' = 'CLOSE_OR_REDUCE';

    await requestJson('/api/execution/execution/execute-ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ticket: {
          instrument: position.symbol,
          conid: position.conid,
          side,
          positionEffect,
          orderType: 'MKT',
          quantity: qty,
          reason: `Manual close/reduce from UI (${side})`,
          confidence: 1,
          riskCheckStatus: 'PASS'
        },
        persist: true,
      })
    });
  }

  useEffect(() => {
    orderFiltersRef.current = orderFilters;
  }, [orderFilters]);

  useEffect(() => {
    const onPopState = () => {
      setRoute(window.location.pathname === '/report' ? 'report' : 'console');
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    const onDocumentClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('.actions-menu')) {
        setOpenActionMenuRowKey(null);
      }
    };

    document.addEventListener('click', onDocumentClick);
    return () => document.removeEventListener('click', onDocumentClick);
  }, []);

  useEffect(() => {
    if (route !== 'console') return;
    const timeout = setTimeout(() => {
      void refreshOrders({ filters: orderFilters }).catch((error) => {
        setLastError((error as Error).message);
      });
    }, 250);

    return () => clearTimeout(timeout);
  }, [orderFilters]);

  useEffect(() => {
    if (route === 'report') {
      void refreshReport();
      return;
    }
    void refreshAll();
  }, [route]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      setNowTick(Date.now());
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (route !== 'console') return;
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
    if (route !== 'console') return;
    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (watchlistPollInFlightRef.current) return;

      watchlistPollInFlightRef.current = true;
      void refreshWatchlist({ silent: true })
        .catch(() => {})
        .finally(() => {
          watchlistPollInFlightRef.current = false;
        });
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (route !== 'console') return;
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
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (route !== 'report') return;
    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void refreshReport({ silent: true }).catch(() => {});
    }, 15000);

    return () => clearInterval(interval);
  }, [route]);

  return (
    <div className="app-shell">
      <header className="hero">
        <h1>IKBR Trader Console</h1>
        <p>
          {route === 'report'
            ? 'Raport skuteczności strategii na bazie zrealizowanych signal outcomes.'
            : 'Ingestion, signal engine i execution w jednym panelu operatorskim.'}
        </p>
        <div className="nav-row">
          <button type="button" className={`nav-link ${route === 'console' ? 'active' : ''}`} onClick={() => navigate('console')}>
            Console
          </button>
          <button type="button" className={`nav-link ${route === 'report' ? 'active' : ''}`} onClick={() => navigate('report')}>
            Report
          </button>
        </div>
      </header>

      {route === 'report' ? (
        <>
          <section className="panel controls">
            <div className="panel-head">
              <h2>Signal Report</h2>
              <span>{loadingReport ? 'loading...' : report ? `last refresh ${formatTs(report.generatedAt)}` : 'not available'}</span>
            </div>
            <div className="action-grid">
              <button disabled={loadingReport} onClick={() => void refreshReport()}>
                Refresh Report
              </button>
            </div>
            <div className="meta-row">
              <span>{report ? `Recent evaluated trades: ${report.limit}` : 'Report not loaded yet'}</span>
              {reportError ? <span className="error">{reportError}</span> : null}
            </div>
          </section>

          {report ? (
            <>
              <section className="panel">
                <div className="panel-head">
                  <h2>Overview</h2>
                  <span>{report.overview.trades} evaluated trades</span>
                </div>
                <div className="metrics-grid">
                  <MetricCard label="Trades" value={formatNum(report.overview.trades, 0)} />
                  <MetricCard label="Win Rate" value={formatPct(report.overview.winRate)} tone={report.overview.avgPnlPct} />
                  <MetricCard label="Avg PnL %" value={formatPnlPct(report.overview.avgPnlPct)} tone={report.overview.avgPnlPct} />
                  <MetricCard label="Median PnL %" value={formatPnlPct(report.overview.medianPnlPct)} tone={report.overview.medianPnlPct} />
                  <MetricCard label="Avg Confidence" value={formatPct(report.overview.avgConfidence)} />
                  <MetricCard label="Take Profit Hits" value={formatNum(report.overview.takeProfitHits, 0)} />
                  <MetricCard label="Stop Hits" value={formatNum(report.overview.stopHits, 0)} tone={report.overview.stopHits > report.overview.takeProfitHits ? -1 : 1} />
                  <MetricCard label="Open / MTM" value={formatNum(report.overview.open, 0)} />
                </div>
              </section>

              <section className="panel">
                <div className="panel-head">
                  <h2>Highlights</h2>
                  <span>Quick read on current weak spots</span>
                </div>
                <div className="report-grid">
                  <div className="metric-card">
                    <small>Weakest Side</small>
                    <strong className={toToneClass(reportWeakestSide?.avgPnlPct)}>
                      {reportWeakestSide ? `${reportWeakestSide.key} (${formatPnlPct(reportWeakestSide.avgPnlPct)})` : '-'}
                    </strong>
                  </div>
                  <div className="metric-card">
                    <small>Weakest Strategy</small>
                    <strong className={toToneClass(reportWeakestStrategy?.avgPnlPct)}>
                      {reportWeakestStrategy ? `${reportWeakestStrategy.key} (${formatPnlPct(reportWeakestStrategy.avgPnlPct)})` : '-'}
                    </strong>
                  </div>
                  <div className="metric-card">
                    <small>Weakest Symbol</small>
                    <strong className={toToneClass(reportWeakestSymbol?.avgPnlPct)}>
                      {reportWeakestSymbol ? `${reportWeakestSymbol.key} (${formatPnlPct(reportWeakestSymbol.avgPnlPct)})` : '-'}
                    </strong>
                  </div>
                </div>
              </section>

              <section className="panel">
                <div className="panel-head">
                  <h2>By Symbol</h2>
                  <span>Most active symbols in current sample</span>
                </div>
                <ReportAggregateTable rows={report.bySymbol} />
              </section>

              <section className="panel">
                <div className="panel-head">
                  <h2>By Strategy</h2>
                  <span>Profile-level outcome summary</span>
                </div>
                <ReportAggregateTable rows={report.byStrategy} />
              </section>

              <section className="panel">
                <div className="panel-head">
                  <h2>By Side</h2>
                  <span>BUY vs SELL quality check</span>
                </div>
                <ReportAggregateTable rows={report.bySide} />
              </section>

              <section className="panel">
                <div className="panel-head">
                  <h2>By Regime</h2>
                  <span>How each market regime is behaving</span>
                </div>
                <ReportAggregateTable rows={report.byRegime} />
              </section>

              <section className="panel">
                <div className="panel-head">
                  <h2>Worst Trades</h2>
                  <span>Lowest PnL trades from current sample</span>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Order ID</th>
                        <th>Symbol</th>
                        <th>Strategy</th>
                        <th>Side</th>
                        <th>Regime</th>
                        <th>Confidence</th>
                        <th>PnL %</th>
                        <th>Outcome</th>
                        <th>Executed At</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.worstTrades.length === 0 ? (
                        <tr>
                          <td colSpan={9} className="muted">No evaluated trades yet</td>
                        </tr>
                      ) : (
                        report.worstTrades.map((trade) => (
                          <tr key={trade.orderId}>
                            <td>{trade.orderId}</td>
                            <td>{trade.instrument}</td>
                            <td>{trade.strategy}</td>
                            <td>{trade.side}</td>
                            <td>{trade.regime}</td>
                            <td>{formatPct(trade.confidence)}</td>
                            <td className={toToneClass(trade.pnlPct)}>{formatPnlPct(trade.pnlPct)}</td>
                            <td>{trade.notes}</td>
                            <td>{formatTs(trade.executedAt)}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          ) : (
            <section className="panel">
              <div className="muted">Report unavailable. Try refreshing after a few filled trades are evaluated.</div>
            </section>
          )}
        </>
      ) : (
        <>
      <section className="panel controls">
        <div className="status-row">
          <StatusPill label="Ingestion" ok={Boolean(ingestionHealth?.ok)} extra={ingestionStatusExtra} />
          <StatusPill label="Signal" ok={Boolean(signalHealth?.ok)} extra={signalStatusExtra} />
          <StatusPill label="Execution" ok={Boolean(executionHealth?.ok)} extra={executionStatusExtra} />
          <StatusPill label="Proposed" ok={proposedCount > 0} extra={String(proposedCount)} />
        </div>

        <div className="action-grid">
          <button
            disabled={Boolean(busyAction)}
            onClick={() =>
              void handleAction(
                watchlist?.bootstrapped ? 'Stop Ingestion' : 'Start Ingestion',
                watchlist?.bootstrapped ? stopIngestion : bootstrapIngestion
              )
            }
          >
            {watchlist?.bootstrapped ? 'Stop Ingestion' : 'Start Ingestion'}
          </button>
          <button disabled={Boolean(busyAction)} onClick={() => void handleAction('Signals run-once', runSignalsOnce)}>Run Signals Once</button>
          <button disabled={Boolean(busyAction)} onClick={() => void handleAction('Execution bootstrap', bootstrapExecution)}>Execution Bootstrap</button>
          <button disabled={Boolean(busyAction)} onClick={() => void handleAction('Refresh', refreshAll)}>Refresh</button>
        </div>

        <div className="action-grid compact">
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
              <MetricCard
                label="Daily Realized PnL"
                value={formatNum(accountSummary.totals.dailyRealizedPnL ?? accountSummary.totals.realizedPnL)}
                tone={accountSummary.totals.dailyRealizedPnL ?? accountSummary.totals.realizedPnL}
              />
              <MetricCard
                label="Cumulative Realized PnL"
                value={formatNum(accountSummary.totals.cumulativeRealizedPnL)}
                tone={accountSummary.totals.cumulativeRealizedPnL}
              />
              <MetricCard label="Gross Exposure" value={formatNum(accountSummary.totals.grossExposure)} />
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
                    <th>Unrealized PnL (base)</th>
                    <th>Realized PnL (base)</th>
                    <th>Exchange</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {accountSummary.positions.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="muted">No open positions</td>
                    </tr>
                  ) : (
                    accountSummary.positions.map((position) => (
                      <tr key={`${position.conid ?? position.symbol}-${position.symbol}`}>
                        <td>{position.symbol}</td>
                        <td>{position.conid ?? '-'}</td>
                        <td>{formatQty(position.position)}</td>
                        <td>{formatNum(position.marketPrice)}</td>
                        <td>{formatNum(position.marketValue)}</td>
                        <td>{formatNum(position.averageCost)}</td>
                        <td className={toToneClass(position.unrealizedPnLBase ?? position.unrealizedPnL)}>
                          {formatNum(position.unrealizedPnLBase ?? position.unrealizedPnL)}
                        </td>
                        <td className={toToneClass(position.realizedPnLBase ?? position.realizedPnL)}>
                          {formatNum(position.realizedPnLBase ?? position.realizedPnL)}
                        </td>
                        <td>{position.exchange ?? '-'}</td>
                        <td>
                          <button
                            disabled={Boolean(busyAction) || !(Math.abs(position.position) > 0)}
                            onClick={() => {
                              const side = position.position > 0 ? 'SELL' : 'BUY';
                              const qty = Math.abs(position.position);
                              const verb = side === 'SELL' ? 'Sell' : 'Buy to cover';
                              const confirmed = window.confirm(
                                `${verb} ${qty} ${position.symbol} (MKT)?`
                              );
                              if (!confirmed) return;
                              void handleAction(`${verb} ${position.symbol}`, async () => executePositionExit(position));
                            }}
                          >
                            {position.position > 0 ? 'Sell' : 'Buy to cover'}
                          </button>
                        </td>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span>{loadingWatchlist ? 'loading...' : `items: ${watchlist?.watchlist.length ?? 0}`}</span>
            <button type="button" onClick={() => setWatchlistExpanded((value) => !value)}>
              {watchlistExpanded ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>
        {watchlistExpanded ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Name</th>
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
                    <td>{item.displayName ?? '-'}</td>
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
        ) : null}
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
            <option value="SUPERSEDED">SUPERSEDED</option>
            <option value="EXPIRED">EXPIRED</option>
          </select>
          <select value={orderFilters.risk} onChange={(e) => setOrderFilters((prev) => ({ ...prev, risk: e.target.value }))}>
            <option value="">Risk: all</option>
            <option value="PASS">PASS</option>
            <option value="REJECT">REJECT</option>
          </select>
          <select value={orderFilters.decisionSource} onChange={(e) => setOrderFilters((prev) => ({ ...prev, decisionSource: e.target.value }))}>
            <option value="">Decision Source: all</option>
            <option value="signal">signal</option>
            <option value="llm">llm</option>
            <option value="user">user</option>
            <option value="user_override">user_override</option>
          </select>
          <select value={orderFilters.aiDecision} onChange={(e) => setOrderFilters((prev) => ({ ...prev, aiDecision: e.target.value }))}>
            <option value="">AI Decision: all</option>
            <option value="EXECUTE">EXECUTE</option>
            <option value="REJECT">REJECT</option>
          </select>
          <button
            type="button"
            disabled={!hasOrderFilters}
            onClick={() => setOrderFilters({ instrument: '', side: '', type: '', qty: '', status: '', risk: '', decisionSource: '', aiDecision: '' })}
          >
            Clear filters
          </button>
        </div>
        <div className="table-wrap">
          <table className="orders-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Symbol</th>
                <th>Regime</th>
                <th>Side</th>
                <th>Qty</th>
                <th>Status</th>
                <th>Risk</th>
                <th>Created at</th>
                <th>Updated at</th>
                <th>Broker</th>
                <th>More</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {orders.length === 0 ? (
                <tr>
                  <td colSpan={12} className="muted">No orders match current filters</td>
                </tr>
              ) : (
                orders.map((order) => {
                  const rowKey = orderRowKey(order);
                  const aiOpen = Boolean(expandedAiOrderRows[rowKey]);
                  const isActionMenuOpen = openActionMenuRowKey === rowKey;
                  const availableActions: Array<{ key: string; label: string; run: () => void }> = [];

                  if (order.status === 'PROPOSED' && order.id !== undefined) {
                    const orderId = order.id as number;
                    availableActions.push({
                      key: 'execute',
                      label: 'Execute',
                      run: () => void handleAction(`Execute order ${orderId}`, async () => executeOrder(orderId))
                    });
                    availableActions.push({
                      key: 'reject',
                      label: 'Reject',
                      run: () => {
                        const reason = window.prompt('Reject reason', 'Manual reject from UI');
                        if (!reason || !reason.trim()) return;
                        void handleAction(`Reject order ${orderId}`, async () => rejectOrder(orderId, reason.trim()));
                      }
                    });
                  }

                  if (order.status === 'REJECTED' && order.decisionSource === 'llm' && order.id !== undefined) {
                    const orderId = order.id as number;
                    availableActions.push({
                      key: 'execute-override',
                      label: 'Execute override',
                      run: () => void handleAction(`Execute override ${orderId}`, async () => executeOrder(orderId, true))
                    });
                  }

                  if (order.status === 'SUBMITTED' && order.id !== undefined) {
                    const orderId = order.id as number;
                    availableActions.push({
                      key: 'cancel',
                      label: 'Cancel',
                      run: () => {
                        const confirmed = window.confirm(`Cancel submitted order #${orderId}?`);
                        if (!confirmed) return;
                        void handleAction(`Cancel order ${orderId}`, async () => cancelOrder(orderId));
                      }
                    });
                  }

                  return (
                    <Fragment key={rowKey}>
                      <tr>
                        <td>{order.id ?? '-'}</td>
                        <td>{order.instrument}</td>
                        <td>{order.indicators?.regime ?? '-'}</td>
                        <td>{order.side}</td>
                        <td>{formatQty(order.quantity)}</td>
                        <td>{order.status}</td>
                        <td>{order.riskCheckStatus}</td>
                        <td>{formatTs(orderCreatedAt(order))}</td>
                        <td>{formatTs(orderUpdatedAt(order))}</td>
                        <td>{order.brokerOrderId ?? '-'}</td>
                        <td>
                          <button
                            type="button"
                            className="ai-toggle-btn"
                            onClick={() => toggleAiPanel(rowKey)}
                          >
                            {aiOpen ? 'Less' : 'More'}
                          </button>
                        </td>
                        <td>
                          <div className="actions-menu">
                            <button
                              type="button"
                              className="actions-trigger"
                              aria-label="Open actions"
                              onClick={() => setOpenActionMenuRowKey((prev) => (prev === rowKey ? null : rowKey))}
                            >
                              <span className="dot" />
                              <span className="dot" />
                              <span className="dot" />
                            </button>
                            {isActionMenuOpen ? (
                              <div className="actions-dropdown">
                                {availableActions.length === 0 ? (
                                  <div className="actions-empty muted">No actions available</div>
                                ) : (
                                  availableActions.map((action) => (
                                    <button
                                      key={action.key}
                                      type="button"
                                      disabled={Boolean(busyAction)}
                                      onClick={() => {
                                        setOpenActionMenuRowKey(null);
                                        action.run();
                                      }}
                                    >
                                      {action.label}
                                    </button>
                                  ))
                                )}
                              </div>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                      {aiOpen ? (
                        <tr className="ai-details-row">
                          <td colSpan={12} className="ai-details-cell">
                            <div className="ai-details-panel">
                              <div className="ai-details-grid">
                                <div><span>Type</span><strong>{order.orderType}</strong></div>
                                <div><span>Confidence</span><strong>{formatPct(order.confidence)}</strong></div>
                                <div><span>Risk</span><strong>{order.riskCheckStatus}</strong></div>
                                <div><span>Regime</span><strong>{order.indicators?.regime ?? '-'}</strong></div>
                                <div><span>Decision Source</span><strong>{order.decisionSource ?? '-'}</strong></div>
                                <div><span>AI Decision</span><strong>{order.aiDecision ?? '-'}</strong></div>
                                <div><span>AI Model</span><strong>{order.aiModel ?? '-'}</strong></div>
                                <div><span>AI Confidence</span><strong>{formatPct(order.aiDecisionConfidence)}</strong></div>
                                <div><span>LLM Decision ID</span><strong>{order.llmDecisionId ?? '-'}</strong></div>
                                <div><span>Cancel Reason</span><strong>{formatCancelReasonLabel(order.cancelReasonCode)}</strong></div>
                                <div><span>Strategy Profile</span><strong>{order.indicators?.strategyProfile ?? '-'}</strong></div>
                              </div>
                              <div className="ai-details-text">
                                <span>Reason</span>
                                <p>{order.reason}</p>
                              </div>
                              <div className="ai-details-text">
                                <span>AI Reason</span>
                                <p>{order.aiReason ?? '-'}</p>
                              </div>
                            <div className="ai-details-text">
                              <span>Source Error</span>
                              <p>{order.sourceError ?? '-'}</p>
                            </div>
                            <div className="ai-details-text">
                              <span>Execution Message</span>
                              <p>{order.executionMessage ?? '-'}</p>
                            </div>
                            <div className="ai-details-text">
                              <span>Last Error</span>
                              <p>{order.lastError ?? '-'}</p>
                            </div>
                            <div className="ai-details-text">
                              <span>Broker Warning</span>
                              <p>{order.brokerWarning ?? '-'}</p>
                            </div>
                            <div className="ai-details-text">
                              <span>Cancel Detail</span>
                              <p>{order.cancelReasonDetail ?? '-'}</p>
                            </div>
                          </div>
                        </td>
                      </tr>
                      ) : null}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
        </>
      )}
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

function ReportAggregateTable({ rows }: { rows: ReportAggregate[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th>Trades</th>
            <th>Wins</th>
            <th>Losses</th>
            <th>Open</th>
            <th>Win Rate</th>
            <th>Avg PnL %</th>
            <th>Median PnL %</th>
            <th>Avg Confidence</th>
            <th>TP Hits</th>
            <th>Stop Hits</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={11} className="muted">No data</td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.key}>
                <td>{row.key}</td>
                <td>{formatNum(row.trades, 0)}</td>
                <td>{formatNum(row.wins, 0)}</td>
                <td>{formatNum(row.losses, 0)}</td>
                <td>{formatNum(row.open, 0)}</td>
                <td>{formatPct(row.winRate)}</td>
                <td className={toToneClass(row.avgPnlPct)}>{formatPnlPct(row.avgPnlPct)}</td>
                <td className={toToneClass(row.medianPnlPct)}>{formatPnlPct(row.medianPnlPct)}</td>
                <td>{formatPct(row.avgConfidence)}</td>
                <td>{formatNum(row.takeProfitHits, 0)}</td>
                <td>{formatNum(row.stopHits, 0)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function toToneClass(value?: number): string {
  if (value === undefined || value === null || Number.isNaN(value) || value === 0) return '';
  return value > 0 ? 'positive' : 'negative';
}
