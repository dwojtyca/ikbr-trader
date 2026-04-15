import IB from 'ib';
import { SignalTicket } from '@ikbr/shared';

interface TwsExecutionConfig {
  host: string;
  port: number;
  clientId: number;
  securityType: string;
  exchange: string;
  primaryExchange?: string;
  currency: string;
  orderTimeoutMs: number;
}

interface ContractShape {
  symbol?: string;
  conId?: number;
  secType?: string;
  exchange?: string;
  primaryExch?: string;
  currency?: string;
}

interface ContractDetailsShape {
  contract?: ContractShape;
  summary?: ContractShape;
}

interface PlaceOrderResult {
  orderId: number;
  status: 'SUBMITTED' | 'FILLED';
  brokerOrderId: string;
}

export interface BrokerOrderStatusUpdate {
  brokerOrderId: string;
  status: string;
  message: string;
}

interface AccountMetricSet {
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
}

interface AccountPositionSnapshot {
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
}

export interface AccountSnapshot {
  accountId: string;
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
}

function toNum(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export class TwsExecutionClient {
  private readonly ib: any;
  private connected = false;
  private nextOrderId = 1;
  private connectPromise?: Promise<void>;

  constructor(
    private readonly config: TwsExecutionConfig,
    private readonly onLog: (line: string) => void,
    private readonly onBrokerOrderStatus?: (update: BrokerOrderStatusUpdate) => void
  ) {
    this.ib = new IB({
      host: config.host,
      port: config.port,
      clientId: config.clientId
    });

    this.bindCoreListeners();
  }

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('TWS execution connect timeout waiting for nextValidId'));
      }, 12_000);

      const cleanup = () => {
        clearTimeout(timeout);
        this.ib.off('nextValidId', onNextValidId);
        this.ib.off('error', onError);
      };

      const onNextValidId = (orderId: number) => {
        this.connected = true;
        this.nextOrderId = Math.max(this.nextOrderId, Number(orderId));
        cleanup();
        resolve();
      };

      const onError = (arg1: unknown, arg2?: unknown) => {
        const parsed = this.parseIbErrorArgs(arg1, arg2);
        if (String(parsed.code) === '502' || String(parsed.code) === '503' || String(parsed.code) === '504') {
          cleanup();
          reject(new Error(`TWS socket connection failed (${parsed.code ?? 'n/a'}): ${parsed.message}`));
        }
      };

      this.ib.once('nextValidId', onNextValidId);
      this.ib.on('error', onError);
      this.ib.connect();
    });

    try {
      await this.connectPromise;
      this.onLog(`execution socket connected ${this.config.host}:${this.config.port}, clientId=${this.config.clientId}`);
    } finally {
      this.connectPromise = undefined;
    }
  }

  disconnect(): void {
    if (!this.connected) return;
    this.ib.disconnect();
    this.connected = false;
  }

  async getManagedAccounts(): Promise<string[]> {
    await this.connect();

    const accounts = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for managedAccounts from TWS execution socket'));
      }, 8_000);

      const cleanup = () => {
        clearTimeout(timeout);
        this.ib.off('managedAccounts', onManagedAccounts);
      };

      const onManagedAccounts = (accountsList: string) => {
        cleanup();
        resolve(accountsList);
      };

      this.ib.once('managedAccounts', onManagedAccounts);
      this.ib.reqManagedAccts();
    });

    return accounts
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  }

  async placeSignalOrder(ticket: SignalTicket, accountId: string, tif: string): Promise<PlaceOrderResult> {
    await this.connect();

    const contract = await this.resolveContract(ticket);
    const orderId = this.allocOrderId();
    const order = this.buildOrder(ticket, accountId, tif);

    return new Promise<PlaceOrderResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting orderStatus for orderId=${orderId}`));
      }, this.config.orderTimeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        this.ib.off('orderStatus', onOrderStatus);
        this.ib.off('error', onError);
      };

      const onOrderStatus = (
        incomingOrderId: number,
        status: string,
        _filled: number,
        _remaining: number,
        _avgFillPrice: number,
        _permId: number,
        _parentId: number,
        _lastFillPrice: number,
        _clientId: number,
        _whyHeld: string,
        _mktCapPrice: number
      ) => {
        if (incomingOrderId !== orderId) return;

        const normalized = String(status || '').toUpperCase();
        if (normalized === 'FILLED') {
          cleanup();
          resolve({ orderId, status: 'FILLED', brokerOrderId: String(orderId) });
          return;
        }

        if (normalized === 'PRESUBMITTED' || normalized === 'SUBMITTED' || normalized === 'PENDINGSUBMIT') {
          cleanup();
          resolve({ orderId, status: 'SUBMITTED', brokerOrderId: String(orderId) });
          return;
        }

        if (normalized === 'INACTIVE' || normalized === 'CANCELLED' || normalized === 'APICANCELLED') {
          cleanup();
          reject(new Error(`Order ${orderId} was not accepted by broker, status=${normalized}`));
        }
      };

      const onError = (arg1: unknown, arg2?: unknown, arg3?: unknown) => {
        const parsed = this.parseIbErrorArgs(arg1, arg2, arg3);
        if (parsed.reqId !== undefined && Number(parsed.reqId) !== orderId) return;

        const code = Number(parsed.code);
        const fatalCodes = new Set([103, 104, 109, 110, 201, 202, 203, 321, 322, 323, 354]);
        if (Number.isFinite(code) && !fatalCodes.has(code)) {
          return;
        }

        cleanup();
        reject(new Error(`Broker rejected order ${orderId}: ${parsed.message} (code=${parsed.code ?? 'n/a'})`));
      };

      this.ib.on('orderStatus', onOrderStatus);
      this.ib.on('error', onError);
      this.ib.placeOrder(orderId, contract, order);
    });
  }

  async getAccountSnapshot(accountId: string): Promise<AccountSnapshot> {
    await this.connect();

    return new Promise<AccountSnapshot>((resolve, reject) => {
      const valuesByKey = new Map<string, Map<string, string>>();
      const positionsByKey = new Map<string, AccountPositionSnapshot>();
      let accountTime: string | undefined;

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting account updates for ${accountId}`));
      }, 10_000);

      const cleanup = () => {
        clearTimeout(timeout);
        this.ib.off('updateAccountValue', onUpdateAccountValue);
        this.ib.off('updatePortfolio', onUpdatePortfolio);
        this.ib.off('updateAccountTime', onUpdateAccountTime);
        this.ib.off('accountDownloadEnd', onAccountDownloadEnd);
        this.ib.off('error', onError);
        try {
          this.ib.reqAccountUpdates(false, accountId);
        } catch {
          // no-op
        }
      };

      const onUpdateAccountValue = (key: string, value: string, currency: string, accountName: string) => {
        if (accountName !== accountId) return;
        if (!valuesByKey.has(key)) valuesByKey.set(key, new Map());
        valuesByKey.get(key)?.set(currency || 'BASE', String(value));
      };

      const onUpdatePortfolio = (
        contract: ContractShape,
        position: number,
        marketPrice: number,
        marketValue: number,
        averageCost: number,
        unrealizedPNL: number,
        realizedPNL: number,
        accountName: string
      ) => {
        if (accountName !== accountId) return;

        const conid = toNum(contract.conId);
        const symbol = String(contract.symbol ?? (conid ? `CONID:${conid}` : 'UNKNOWN'));
        const key = conid ? `conid:${conid}` : `symbol:${symbol}`;

        if (!Number.isFinite(position) || Math.abs(position) < 1e-12) {
          positionsByKey.delete(key);
          return;
        }

        positionsByKey.set(key, {
          conid: conid ? String(conid) : undefined,
          symbol,
          secType: typeof contract.secType === 'string' ? contract.secType : undefined,
          exchange: typeof contract.exchange === 'string' ? contract.exchange : undefined,
          currency: typeof contract.currency === 'string' ? contract.currency : undefined,
          position: Number(position),
          marketPrice: toNum(marketPrice),
          marketValue: toNum(marketValue),
          averageCost: toNum(averageCost),
          unrealizedPnL: toNum(unrealizedPNL),
          realizedPnL: toNum(realizedPNL)
        });
      };

      const onUpdateAccountTime = (stamp: string) => {
        accountTime = stamp;
      };

      const onAccountDownloadEnd = (accountName: string) => {
        if (accountName !== accountId) return;
        cleanup();
        resolve(this.buildAccountSnapshot(accountId, valuesByKey, positionsByKey, accountTime));
      };

      const onError = (arg1: unknown, arg2?: unknown, arg3?: unknown) => {
        const parsed = this.parseIbErrorArgs(arg1, arg2, arg3);
        const code = Number(parsed.code);
        if (!Number.isFinite(code)) return;

        const fatal = new Set([200, 201, 321, 322, 323, 502, 503, 504]);
        if (!fatal.has(code)) return;

        cleanup();
        reject(new Error(`Failed to fetch account snapshot: ${parsed.message} (code=${parsed.code ?? 'n/a'})`));
      };

      this.ib.on('updateAccountValue', onUpdateAccountValue);
      this.ib.on('updatePortfolio', onUpdatePortfolio);
      this.ib.on('updateAccountTime', onUpdateAccountTime);
      this.ib.on('accountDownloadEnd', onAccountDownloadEnd);
      this.ib.on('error', onError);
      this.ib.reqAccountUpdates(true, accountId);
    });
  }

  private buildOrder(ticket: SignalTicket, accountId: string, tif: string): Record<string, unknown> {
    if (ticket.side !== 'BUY' && ticket.side !== 'SELL') {
      throw new Error(`Execution supports BUY/SELL only, got ${ticket.side}`);
    }
    if (ticket.quantity <= 0) {
      throw new Error('Quantity must be > 0');
    }

    const orderType = ticket.orderType.toUpperCase();
    const base: Record<string, unknown> = {
      action: ticket.side,
      totalQuantity: ticket.quantity,
      orderType,
      tif,
      account: accountId,
      transmit: true
    };

    if (orderType === 'LMT') {
      if (ticket.entry === undefined || !Number.isFinite(ticket.entry)) {
        throw new Error('LMT order requires ticket.entry');
      }
      base.lmtPrice = ticket.entry;
    }

    if (orderType !== 'MKT' && orderType !== 'LMT') {
      throw new Error(`Unsupported orderType for current execution engine: ${ticket.orderType}`);
    }

    return base;
  }

  private async resolveContract(ticket: SignalTicket): Promise<ContractShape> {
    if (ticket.conid && Number.isFinite(Number(ticket.conid))) {
      return this.withDefaults({
        conId: Number(ticket.conid),
        symbol: ticket.instrument
      });
    }

    const reqId = this.allocOrderId() + 100_000;
    const contract = this.withDefaults({ symbol: ticket.instrument });

    return new Promise<ContractShape>((resolve, reject) => {
      let firstDetails: ContractDetailsShape | undefined;

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting contractDetails for ${ticket.instrument}`));
      }, 8_000);

      const cleanup = () => {
        clearTimeout(timeout);
        this.ib.off('contractDetails', onContractDetails);
        this.ib.off('contractDetailsEnd', onContractDetailsEnd);
        this.ib.off('error', onError);
      };

      const onContractDetails = (incomingReqId: number, details: ContractDetailsShape) => {
        if (incomingReqId !== reqId) return;
        if (!firstDetails) firstDetails = details;
      };

      const onContractDetailsEnd = (incomingReqId: number) => {
        if (incomingReqId !== reqId) return;
        cleanup();

        const summary = firstDetails?.contract ?? firstDetails?.summary;
        if (!summary) {
          reject(new Error(`No contract details for ${ticket.instrument}`));
          return;
        }

        const conId = toNum(summary.conId);
        if (!conId) {
          reject(new Error(`No conId in contract details for ${ticket.instrument}`));
          return;
        }

        resolve(this.withDefaults({
          conId,
          symbol: String(summary.symbol ?? ticket.instrument),
          primaryExch: typeof summary.primaryExch === 'string' ? summary.primaryExch : undefined
        }));
      };

      const onError = (arg1: unknown, arg2?: unknown, arg3?: unknown) => {
        const parsed = this.parseIbErrorArgs(arg1, arg2, arg3);
        if (parsed.reqId !== undefined && Number(parsed.reqId) !== reqId) return;
        cleanup();
        reject(new Error(`contractDetails error for ${ticket.instrument}: ${parsed.message} (code=${parsed.code ?? 'n/a'})`));
      };

      this.ib.on('contractDetails', onContractDetails);
      this.ib.on('contractDetailsEnd', onContractDetailsEnd);
      this.ib.on('error', onError);
      this.ib.reqContractDetails(reqId, contract);
    });
  }

  private withDefaults(contract: ContractShape): ContractShape {
    return {
      secType: this.config.securityType,
      exchange: this.config.exchange,
      currency: this.config.currency,
      ...(this.config.primaryExchange ? { primaryExch: this.config.primaryExchange } : {}),
      ...contract
    };
  }

  private buildAccountSnapshot(
    accountId: string,
    valuesByKey: Map<string, Map<string, string>>,
    positionsByKey: Map<string, AccountPositionSnapshot>,
    accountTime?: string
  ): AccountSnapshot {
    const positions = Array.from(positionsByKey.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));

    let longExposure = 0;
    let shortExposure = 0;
    let unrealizedPnLFromPositions = 0;
    let realizedPnLFromPositions = 0;

    for (const position of positions) {
      const mv = position.marketValue ?? 0;
      if (mv >= 0) longExposure += mv;
      else shortExposure += Math.abs(mv);

      unrealizedPnLFromPositions += position.unrealizedPnL ?? 0;
      realizedPnLFromPositions += position.realizedPnL ?? 0;
    }

    const metrics: AccountMetricSet = {
      netLiquidation: this.pickAccountMetric(valuesByKey, 'NetLiquidation'),
      totalCashValue: this.pickAccountMetric(valuesByKey, 'TotalCashValue'),
      settledCash: this.pickAccountMetric(valuesByKey, 'SettledCash'),
      buyingPower: this.pickAccountMetric(valuesByKey, 'BuyingPower'),
      availableFunds: this.pickAccountMetric(valuesByKey, 'AvailableFunds'),
      excessLiquidity: this.pickAccountMetric(valuesByKey, 'ExcessLiquidity'),
      equityWithLoanValue: this.pickAccountMetric(valuesByKey, 'EquityWithLoanValue'),
      grossPositionValue: this.pickAccountMetric(valuesByKey, 'GrossPositionValue'),
      initMarginReq: this.pickAccountMetric(valuesByKey, 'InitMarginReq'),
      maintMarginReq: this.pickAccountMetric(valuesByKey, 'MaintMarginReq'),
      unrealizedPnL: this.pickAccountMetric(valuesByKey, 'UnrealizedPnL'),
      realizedPnL: this.pickAccountMetric(valuesByKey, 'RealizedPnL'),
      cushion: this.pickAccountMetric(valuesByKey, 'Cushion')
    };

    return {
      accountId,
      retrievedAt: new Date().toISOString(),
      accountTime,
      metrics,
      totals: {
        positionsCount: positions.length,
        longExposure,
        shortExposure,
        grossExposure: longExposure + shortExposure,
        netExposure: longExposure - shortExposure,
        unrealizedPnL: metrics.unrealizedPnL ?? unrealizedPnLFromPositions,
        realizedPnL: metrics.realizedPnL ?? realizedPnLFromPositions
      },
      positions
    };
  }

  private pickAccountMetric(valuesByKey: Map<string, Map<string, string>>, key: string): number | undefined {
    const byCurrency = valuesByKey.get(key);
    if (!byCurrency) return undefined;

    const candidate = byCurrency.get('BASE') ?? byCurrency.get('USD') ?? Array.from(byCurrency.values())[0];
    return toNum(candidate);
  }

  private bindCoreListeners(): void {
    this.ib.on('connected', () => {
      this.onLog('execution socket connected event received');
    });

    this.ib.on('disconnected', () => {
      this.onLog('execution socket disconnected');
      this.connected = false;
    });

    this.ib.on('error', (arg1: unknown, arg2?: unknown, arg3?: unknown) => {
      const parsed = this.parseIbErrorArgs(arg1, arg2, arg3);
      const prefix = parsed.reqId !== undefined ? `reqId=${parsed.reqId}` : 'reqId=n/a';
      this.onLog(`execution TWS error code=${parsed.code ?? 'n/a'} ${prefix}: ${parsed.message}`);
    });

    this.ib.on(
      'orderStatus',
      (
        orderId: number,
        status: string,
        filled: number,
        remaining: number
      ) => {
        const normalized = String(status || '').toUpperCase();
        this.onLog(`execution orderStatus orderId=${orderId} status=${normalized} filled=${filled} remaining=${remaining}`);
        this.onBrokerOrderStatus?.({
          brokerOrderId: String(orderId),
          status: normalized,
          message: `Broker order status update: ${normalized} (filled=${filled}, remaining=${remaining})`
        });
      }
    );
  }

  private parseIbErrorArgs(arg1: unknown, arg2?: unknown, arg3?: unknown): { code?: number | string; reqId?: number | string; message: string } {
    let code: number | string | undefined;
    let reqId: number | string | undefined;
    let message = 'unknown IB error';

    if (typeof arg1 === 'string') {
      message = arg1;
    } else if (arg1 instanceof Error) {
      message = arg1.message;
    } else if (arg1 && typeof arg1 === 'object') {
      const obj = arg1 as Record<string, unknown>;
      if (obj.message !== undefined) message = String(obj.message);
      if (obj.code !== undefined) code = String(obj.code);
      if (obj.reqId !== undefined) reqId = String(obj.reqId);
      if (obj.id !== undefined && reqId === undefined) reqId = String(obj.id);
      if (obj.errorCode !== undefined && code === undefined) code = String(obj.errorCode);
    }

    if (typeof arg2 === 'number' || typeof arg2 === 'string') {
      code = arg2;
    } else if (arg2 && typeof arg2 === 'object') {
      const obj = arg2 as Record<string, unknown>;
      if (obj.code !== undefined) code = String(obj.code);
      if (obj.errorCode !== undefined && code === undefined) code = String(obj.errorCode);
      if (obj.reqId !== undefined && reqId === undefined) reqId = String(obj.reqId);
      if (obj.id !== undefined && reqId === undefined) reqId = String(obj.id);
    }

    if (typeof arg3 === 'number' || typeof arg3 === 'string') {
      reqId = arg3;
    }

    return { code, reqId, message };
  }

  private allocOrderId(): number {
    const id = this.nextOrderId;
    this.nextOrderId += 1;
    return id;
  }
}
