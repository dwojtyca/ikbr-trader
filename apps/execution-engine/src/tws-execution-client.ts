import IB from "ib";
import { SignalTicket } from "@ikbr/shared";
import { assertClientDirectTicketAllowed } from "./direct-ticket-guard.js";

interface TwsExecutionConfig {
  host: string;
  port: number;
  clientId: number;
  securityType: string;
  exchange: string;
  primaryExchange?: string;
  currency: string;
  orderTimeoutMs: number;
  submittedAutoCancelMs?: number;
  retryAsMktOnCode110?: boolean;
  fractionalSymbols?: Set<string>;
  blockOutsideUsRth?: boolean;
  usRthOpenBufferMin?: number;
  usRthCloseBufferMin?: number;
  contractFallbackByConid?: Record<
    string,
    {
      symbol?: string;
      secType?: string;
      exchange?: string;
      primaryExch?: string;
      currency?: string;
    }
  >;
  environment?: "paper" | "live";
  allowDirectTicket?: boolean;
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
  minTick?: number | string;
}

interface PlaceOrderResult {
  orderId: number;
  status: "SUBMITTED" | "FILLED";
  brokerOrderId: string;
}

interface CancelOrderResult {
  brokerOrderId: string;
  status: "CANCELLED" | "PENDING_CANCEL";
}

interface ResolvedContract {
  contract: ContractShape;
  minTick?: number;
}

interface EffectiveTick {
  tick?: number;
  source: "none" | "minTick" | "wse_ladder" | "us_sec612";
}

interface PlannedOrder {
  orderId: number;
  order: Record<string, unknown>;
}

interface PlannedBracketLeg {
  takeProfitOrderId: number;
  stopLossOrderId: number;
  quantity: number;
  takeProfitPrice: number;
  stopPrice: number;
  ocaGroup: string;
  isPartial: boolean;
}

interface PlaceOrderPlan {
  parentOrderId: number;
  orders: PlannedOrder[];
  relatedOrderIds: Set<number>;
  bracket?: {
    takeProfitOrderId: number;
    stopLossOrderId: number;
  };
  /**
   * When the ticket includes a partial-take-profit ladder, the bracket is
   * split into one independent (TP, STP) pair per ladder rung plus a runner
   * pair. Each pair lives in its own OCA group (ocaType=2) so that filling
   * one TP cancels only its sibling stop, leaving the rest of the ladder
   * intact. The `bracket` summary above points at the runner pair for
   * back-compat with verification/logging that knows about a single bracket.
   */
  bracketLegs?: PlannedBracketLeg[];
}

interface OpenOrderContext {
  symbol: string;
  side: SignalTicket["side"];
  positionEffect?: SignalTicket["positionEffect"];
  role: "parent" | "take_profit" | "stop_loss";
  parentOrderId?: number;
}

export interface BrokerExecutionFill {
  execId: string;
  orderId?: number;
  accountId?: string;
  conid?: string;
  symbol: string;
  currency?: string;
  exchange?: string;
  side: "BUY" | "SELL";
  shares: number;
  price: number;
  avgPrice?: number;
  executedAt?: string;
}

export interface BrokerCommissionReport {
  execId: string;
  commission?: number;
  currency?: string;
  realizedPnL?: number;
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
  unrealizedPnLBase?: number;
  realizedPnLBase?: number;
}

export interface AccountSnapshot {
  accountId: string;
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
  };
  positions: AccountPositionSnapshot[];
}

const IBKR_UNSET_DOUBLE_THRESHOLD = 1e307;

function toNum(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function toBrokerRealizedPnl(value: unknown): number | undefined {
  const parsed = toNum(value);
  if (parsed === undefined) return undefined;
  if (Math.abs(parsed) >= IBKR_UNSET_DOUBLE_THRESHOLD) return undefined;
  return parsed;
}

export class TwsExecutionClient {
  private readonly ib: any;
  private connected = false;
  private nextOrderId = 1;
  private connectPromise?: Promise<void>;
  private readonly openOrderContext = new Map<number, OpenOrderContext>();
  private readonly orderStatusById = new Map<number, string>();
  private readonly bracketPlansByParent = new Map<
    number,
    {
      symbol: string;
      takeProfitOrderId: number;
      stopLossOrderId: number;
    }
  >();
  private readonly bracketVerificationTimers = new Map<
    number,
    ReturnType<typeof setTimeout>
  >();
  private readonly locateAutoCancelAttempted = new Set<number>();
  private readonly submittedAutoCancelTimers = new Map<
    number,
    ReturnType<typeof setTimeout>
  >();
  private readonly brokerOrderWarnings = new Map<number, string[]>();
  private nextRequestId = 1_000_000;

  constructor(
    private readonly config: TwsExecutionConfig,
    private readonly onLog: (line: string) => void,
    private readonly onBrokerOrderStatus?: (
      update: BrokerOrderStatusUpdate,
    ) => void,
    private readonly onBrokerExecutionFill?: (
      fill: BrokerExecutionFill,
    ) => void,
    private readonly onBrokerCommissionReport?: (
      report: BrokerCommissionReport,
    ) => void,
  ) {
    this.ib = new IB({
      host: config.host,
      port: config.port,
      clientId: config.clientId,
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
        reject(
          new Error("TWS execution connect timeout waiting for nextValidId"),
        );
      }, 12_000);

      const cleanup = () => {
        clearTimeout(timeout);
        this.ib.off("nextValidId", onNextValidId);
        this.ib.off("error", onError);
      };

      const onNextValidId = (orderId: number) => {
        this.connected = true;
        this.nextOrderId = Math.max(this.nextOrderId, Number(orderId));
        cleanup();
        resolve();
      };

      const onError = (arg1: unknown, arg2?: unknown) => {
        const parsed = this.parseIbErrorArgs(arg1, arg2);
        if (
          String(parsed.code) === "502" ||
          String(parsed.code) === "503" ||
          String(parsed.code) === "504"
        ) {
          cleanup();
          reject(
            new Error(
              `TWS socket connection failed (${parsed.code ?? "n/a"}): ${parsed.message}`,
            ),
          );
        }
      };

      this.ib.once("nextValidId", onNextValidId);
      this.ib.on("error", onError);
      this.ib.connect();
    });

    try {
      await this.connectPromise;
      this.onLog(
        `execution socket connected ${this.config.host}:${this.config.port}, clientId=${this.config.clientId}`,
      );
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
        reject(
          new Error(
            "Timed out waiting for managedAccounts from TWS execution socket",
          ),
        );
      }, 8_000);

      const cleanup = () => {
        clearTimeout(timeout);
        this.ib.off("managedAccounts", onManagedAccounts);
      };

      const onManagedAccounts = (accountsList: string) => {
        cleanup();
        resolve(accountsList);
      };

      this.ib.once("managedAccounts", onManagedAccounts);
      this.ib.reqManagedAccts();
    });

    return accounts
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }

  async placeSignalOrder(
    ticket: SignalTicket,
    accountId: string,
    tif: string,
    context?: { proposedOrderId?: number | string | null },
  ): Promise<PlaceOrderResult> {
    assertClientDirectTicketAllowed({
      proposedOrderId: context?.proposedOrderId ?? null,
      environment: this.config.environment ?? "paper",
      allowDirectTicket: this.config.allowDirectTicket === true,
    });

    await this.connect();

    const resolvedContract = await this.resolveContract(ticket);
    const contract = resolvedContract.contract;

    // Defense-in-depth: floor non-integer qty for symbols outside the
    // fractional whitelist. Signal-engine should already do this via
    // quantityStepForSymbol, but a stale or misconfigured profile could
    // leak fractional shares and trigger IBKR cancel code 320.
    const guardedTicket = this.enforceIntegerQuantityIfNeeded(ticket);

    // Block entries outside US RTH window. SUBMITTED limit orders sit
    // unfilled until auto-cancel timeout fires, wasting slots. Always
    // allow CLOSE_OR_REDUCE so the bot can flatten outside hours.
    this.assertUsRthAllows(contract, guardedTicket);

    const effectiveTick = this.determineEffectiveTick(
      contract,
      guardedTicket,
      resolvedContract.minTick,
    );
    const normalizedTicket = this.normalizeTicketPrices(
      guardedTicket,
      effectiveTick.tick,
    );

    if (
      effectiveTick.tick &&
      this.wasTicketNormalized(guardedTicket, normalizedTicket)
    ) {
      this.onLog(
        `execution price normalization conid=${guardedTicket.conid ?? "n/a"} source=${effectiveTick.source} rawMinTick=${resolvedContract.minTick ?? "n/a"} effectiveTick=${effectiveTick.tick} entry=${guardedTicket.entry ?? "n/a"}->${normalizedTicket.entry ?? "n/a"} stop=${guardedTicket.stop ?? "n/a"}->${normalizedTicket.stop ?? "n/a"} tp=${guardedTicket.takeProfit ?? "n/a"}->${normalizedTicket.takeProfit ?? "n/a"}`,
      );
    }

    try {
      return await this.placeSignalOrderAttempt(
        contract,
        normalizedTicket,
        accountId,
        tif,
      );
    } catch (error) {
      const message = (error as Error).message;
      const shouldRetryAsMkt =
        this.config.retryAsMktOnCode110 === true &&
        String(guardedTicket.orderType || "").toUpperCase() === "LMT" &&
        message.includes("code=110");

      if (!shouldRetryAsMkt) {
        throw error;
      }

      const retryTicket: SignalTicket = {
        ...normalizedTicket,
        orderType: "MKT",
        entry: undefined,
      };

      this.onLog(
        `execution retry-as-mkt triggered symbol=${guardedTicket.instrument} conid=${guardedTicket.conid ?? "n/a"} reason=code110`,
      );

      return this.placeSignalOrderAttempt(
        contract,
        retryTicket,
        accountId,
        tif,
      );
    }
  }

  private placeSignalOrderAttempt(
    contract: ContractShape,
    ticket: SignalTicket,
    accountId: string,
    tif: string,
  ): Promise<PlaceOrderResult> {
    const plan = this.buildOrderPlan(ticket, accountId, tif);
    const { parentOrderId } = plan;
    this.trackOrderPlanContext(plan, ticket);

    if (plan.bracket) {
      const legCount = plan.bracketLegs?.length ?? 1;
      const partialCount =
        plan.bracketLegs?.filter((leg) => leg.isPartial).length ?? 0;
      const legDetail =
        plan.bracketLegs && plan.bracketLegs.length > 1
          ? " legs=" +
            plan.bracketLegs
              .map(
                (leg) =>
                  `${leg.isPartial ? "p" : "r"}@${leg.takeProfitPrice}/x${leg.quantity}`,
              )
              .join(",")
          : "";
      const trailDetail = ticket.trailingStopPct
        ? ` trail=${ticket.trailingStopPct}%`
        : "";
      this.onLog(
        `execution bracket staged parent=${parentOrderId} tp=${plan.bracket.takeProfitOrderId} sl=${plan.bracket.stopLossOrderId} legs=${legCount} partials=${partialCount}${trailDetail}${legDetail}`,
      );
      if (
        ticket.trailingStopActivationR !== undefined &&
        ticket.trailingStopActivationR > 0
      ) {
        // Live BE+trail (delayed activation) requires a market-data watcher
        // + cancel-and-replace on trigger. Not implemented in execution-engine
        // yet (ib@0.2.x has no native Adjustable Order support). The ticket
        // value is preserved for backtest fidelity and persisted in
        // proposed_orders for audit; the live bracket falls back to the
        // configured trailingStopPct (or static stop) from order creation.
        this.onLog(
          `execution bracket WARN parent=${parentOrderId} trailingStopActivationR=${ticket.trailingStopActivationR} requested but live activation gate is not implemented; trailing stop (if any) is armed from entry`,
        );
      }
    }

    return new Promise<PlaceOrderResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Timed out waiting orderStatus for orderId=${parentOrderId}`,
          ),
        );
      }, this.config.orderTimeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        this.ib.off("orderStatus", onOrderStatus);
        this.ib.off("error", onError);
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
        _mktCapPrice: number,
      ) => {
        if (incomingOrderId !== parentOrderId) return;

        const normalized = String(status || "").toUpperCase();
        if (normalized === "FILLED") {
          cleanup();
          this.clearParentOrderContext(parentOrderId);
          resolve({
            orderId: parentOrderId,
            status: "FILLED",
            brokerOrderId: String(parentOrderId),
          });
          return;
        }

        if (
          normalized === "PRESUBMITTED" ||
          normalized === "SUBMITTED" ||
          normalized === "PENDINGSUBMIT"
        ) {
          cleanup();
          resolve({
            orderId: parentOrderId,
            status: "SUBMITTED",
            brokerOrderId: String(parentOrderId),
          });
          return;
        }

        if (
          normalized === "INACTIVE" ||
          normalized === "CANCELLED" ||
          normalized === "APICANCELLED"
        ) {
          cleanup();
          this.clearParentOrderContext(parentOrderId);
          reject(
            new Error(
              `Order ${parentOrderId} was not accepted by broker, status=${normalized}`,
            ),
          );
        }
      };

      const onError = (arg1: unknown, arg2?: unknown, arg3?: unknown) => {
        const parsed = this.parseIbErrorArgs(arg1, arg2, arg3);
        if (
          parsed.reqId !== undefined &&
          !plan.relatedOrderIds.has(Number(parsed.reqId))
        )
          return;

        const code = Number(parsed.code);
        const fatalCodes = new Set([
          103, 104, 109, 110, 200, 201, 202, 203, 320, 321, 322, 323, 354,
        ]);
        if (Number.isFinite(code) && !fatalCodes.has(code)) {
          return;
        }

        cleanup();
        this.clearParentOrderContext(parentOrderId);
        reject(
          new Error(
            `Broker rejected order ${parentOrderId}: ${parsed.message} (code=${parsed.code ?? "n/a"}, reqId=${parsed.reqId ?? "n/a"})`,
          ),
        );
      };

      this.ib.on("orderStatus", onOrderStatus);
      this.ib.on("error", onError);
      try {
        for (const plannedOrder of plan.orders) {
          this.ib.placeOrder(
            plannedOrder.orderId,
            contract,
            plannedOrder.order,
          );
        }
      } catch (error) {
        cleanup();
        reject(error as Error);
      }
    });
  }

  async cancelBrokerOrder(brokerOrderId: string): Promise<CancelOrderResult> {
    await this.connect();

    const orderId = Number.parseInt(String(brokerOrderId), 10);
    if (!Number.isFinite(orderId) || orderId <= 0) {
      throw new Error(`Invalid brokerOrderId for cancel: ${brokerOrderId}`);
    }

    return new Promise<CancelOrderResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Timed out waiting cancel confirmation for brokerOrderId=${orderId}`,
          ),
        );
      }, this.config.orderTimeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        this.ib.off("orderStatus", onOrderStatus);
        this.ib.off("error", onError);
      };

      const onOrderStatus = (incomingOrderId: number, status: string) => {
        if (incomingOrderId !== orderId) return;

        const normalized = String(status || "").toUpperCase();
        if (
          normalized === "CANCELLED" ||
          normalized === "APICANCELLED" ||
          normalized === "INACTIVE"
        ) {
          cleanup();
          resolve({ brokerOrderId: String(orderId), status: "CANCELLED" });
          return;
        }

        if (normalized === "PENDINGCANCEL") {
          cleanup();
          resolve({ brokerOrderId: String(orderId), status: "PENDING_CANCEL" });
          return;
        }

        if (normalized === "FILLED") {
          cleanup();
          reject(
            new Error(`Order ${orderId} already FILLED; cancel not possible`),
          );
        }
      };

      const onError = (arg1: unknown, arg2?: unknown, arg3?: unknown) => {
        const parsed = this.parseIbErrorArgs(arg1, arg2, arg3);
        if (parsed.reqId !== undefined && Number(parsed.reqId) !== orderId)
          return;

        const code = Number(parsed.code);
        const fatalCodes = new Set([
          135, 161, 201, 202, 321, 322, 323, 354, 10147, 10148,
        ]);
        if (Number.isFinite(code) && !fatalCodes.has(code)) {
          return;
        }

        cleanup();
        reject(
          new Error(
            `Broker cancel failed for order ${orderId}: ${parsed.message} (code=${parsed.code ?? "n/a"})`,
          ),
        );
      };

      this.ib.on("orderStatus", onOrderStatus);
      this.ib.on("error", onError);

      try {
        this.onLog(`execution cancel requested orderId=${orderId}`);
        this.ib.cancelOrder(orderId);
      } catch (error) {
        cleanup();
        reject(error as Error);
      }
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
        this.ib.off("updateAccountValue", onUpdateAccountValue);
        this.ib.off("updatePortfolio", onUpdatePortfolio);
        this.ib.off("updateAccountTime", onUpdateAccountTime);
        this.ib.off("accountDownloadEnd", onAccountDownloadEnd);
        this.ib.off("error", onError);
        try {
          this.ib.reqAccountUpdates(false, accountId);
        } catch {
          // no-op
        }
      };

      const onUpdateAccountValue = (
        key: string,
        value: string,
        currency: string,
        accountName: string,
      ) => {
        if (accountName !== accountId) return;
        if (!valuesByKey.has(key)) valuesByKey.set(key, new Map());
        valuesByKey.get(key)?.set(currency || "BASE", String(value));
      };

      const onUpdatePortfolio = (
        contract: ContractShape,
        position: number,
        marketPrice: number,
        marketValue: number,
        averageCost: number,
        unrealizedPNL: number,
        realizedPNL: number,
        accountName: string,
      ) => {
        if (accountName !== accountId) return;

        const conid = toNum(contract.conId);
        const symbol = String(
          contract.symbol ?? (conid ? `CONID:${conid}` : "UNKNOWN"),
        );
        const key = conid ? `conid:${conid}` : `symbol:${symbol}`;

        if (!Number.isFinite(position) || Math.abs(position) < 1e-12) {
          positionsByKey.delete(key);
          return;
        }

        positionsByKey.set(key, {
          conid: conid ? String(conid) : undefined,
          symbol,
          secType:
            typeof contract.secType === "string" ? contract.secType : undefined,
          exchange:
            typeof contract.exchange === "string"
              ? contract.exchange
              : undefined,
          currency:
            typeof contract.currency === "string"
              ? contract.currency
              : undefined,
          position: Number(position),
          marketPrice: toNum(marketPrice),
          marketValue: toNum(marketValue),
          averageCost: toNum(averageCost),
          unrealizedPnL: toNum(unrealizedPNL),
          realizedPnL: toNum(realizedPNL),
        });
      };

      const onUpdateAccountTime = (stamp: string) => {
        accountTime = stamp;
      };

      const onAccountDownloadEnd = (accountName: string) => {
        if (accountName !== accountId) return;
        cleanup();
        resolve(
          this.buildAccountSnapshot(
            accountId,
            valuesByKey,
            positionsByKey,
            accountTime,
          ),
        );
      };

      const onError = (arg1: unknown, arg2?: unknown, arg3?: unknown) => {
        const parsed = this.parseIbErrorArgs(arg1, arg2, arg3);
        const code = Number(parsed.code);
        if (!Number.isFinite(code)) return;

        const fatal = new Set([200, 201, 321, 322, 323, 502, 503, 504]);
        if (!fatal.has(code)) return;

        cleanup();
        reject(
          new Error(
            `Failed to fetch account snapshot: ${parsed.message} (code=${parsed.code ?? "n/a"})`,
          ),
        );
      };

      this.ib.on("updateAccountValue", onUpdateAccountValue);
      this.ib.on("updatePortfolio", onUpdatePortfolio);
      this.ib.on("updateAccountTime", onUpdateAccountTime);
      this.ib.on("accountDownloadEnd", onAccountDownloadEnd);
      this.ib.on("error", onError);
      this.ib.reqAccountUpdates(true, accountId);
    });
  }

  async syncExecutions(accountId: string, since?: Date): Promise<number> {
    await this.connect();

    const reqId = this.allocRequestId();
    const filter = {
      clientId: 0,
      acctCode: accountId,
      time: since ? this.formatExecutionFilterTime(since) : "",
      symbol: "",
      secType: "",
      exchange: "",
      side: "",
    };

    return new Promise<number>((resolve, reject) => {
      let count = 0;
      let done = false;
      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(`Timed out waiting execDetailsEnd for reqId=${reqId}`),
        );
      }, 15_000);

      const cleanup = () => {
        clearTimeout(timeout);
        this.ib.off("execDetails", onExecDetails);
        this.ib.off("execDetailsEnd", onExecDetailsEnd);
        this.ib.off("error", onError);
      };

      const finish = () => {
        if (done) return;
        done = true;
        cleanup();
        resolve(count);
      };

      const onExecDetails = (incomingReqId: number) => {
        if (incomingReqId !== reqId) return;
        count += 1;
      };

      const onExecDetailsEnd = (incomingReqId: number) => {
        if (incomingReqId !== reqId) return;
        setTimeout(finish, 500);
      };

      const onError = (arg1: unknown, arg2?: unknown, arg3?: unknown) => {
        const parsed = this.parseIbErrorArgs(arg1, arg2, arg3);
        if (parsed.reqId !== undefined && Number(parsed.reqId) !== reqId)
          return;

        const code = Number(parsed.code);
        if (
          Number.isFinite(code) &&
          !new Set([162, 200, 321, 322, 323]).has(code)
        )
          return;
        cleanup();
        reject(
          new Error(
            `reqExecutions failed for reqId=${reqId}: ${parsed.message} (code=${parsed.code ?? "n/a"})`,
          ),
        );
      };

      this.ib.on("execDetails", onExecDetails);
      this.ib.on("execDetailsEnd", onExecDetailsEnd);
      this.ib.on("error", onError);

      try {
        this.ib.reqExecutions(reqId, filter);
      } catch (error) {
        cleanup();
        reject(error as Error);
      }
    });
  }

  private buildOrderPlan(
    ticket: SignalTicket,
    accountId: string,
    tif: string,
  ): PlaceOrderPlan {
    const parentOrderId = this.allocOrderId();
    const attachBracket = this.shouldAttachBracket(ticket);
    const parentOrder = this.buildParentOrder(
      ticket,
      accountId,
      tif,
      !attachBracket,
    );

    if (!attachBracket) {
      return {
        parentOrderId,
        orders: [{ orderId: parentOrderId, order: parentOrder }],
        relatedOrderIds: new Set([parentOrderId]),
      };
    }

    this.validateBracket(ticket);

    const oppositeAction = ticket.side === "BUY" ? "SELL" : "BUY";
    const legs = this.planBracketLegs(ticket);

    const ordersList: PlannedOrder[] = [
      { orderId: parentOrderId, order: parentOrder },
    ];
    const relatedOrderIds = new Set<number>([parentOrderId]);

    legs.forEach((leg, idx) => {
      const isLastLeg = idx === legs.length - 1;
      const takeProfitOrder: Record<string, unknown> = {
        action: oppositeAction,
        totalQuantity: leg.quantity,
        orderType: "LMT",
        lmtPrice: leg.takeProfitPrice,
        tif,
        account: accountId,
        parentId: parentOrderId,
        ocaGroup: leg.ocaGroup,
        ocaType: 2,
        transmit: false,
      };
      const useTrail =
        ticket.trailingStopPct !== undefined &&
        Number.isFinite(ticket.trailingStopPct) &&
        ticket.trailingStopPct > 0;
      const stopLossOrder: Record<string, unknown> = useTrail
        ? {
            action: oppositeAction,
            totalQuantity: leg.quantity,
            orderType: "TRAIL",
            // IBKR ratchets the stop by `trailingPercent` (e.g. 1.5 for 1.5%)
            // away from the best price seen since order creation.
            trailingPercent: ticket.trailingStopPct,
            // Initial stop level — also acts as the worst-case floor before
            // the trail starts following the price.
            trailStopPrice: leg.stopPrice,
            tif,
            account: accountId,
            parentId: parentOrderId,
            ocaGroup: leg.ocaGroup,
            ocaType: 2,
            transmit: isLastLeg,
          }
        : {
            action: oppositeAction,
            totalQuantity: leg.quantity,
            orderType: "STP",
            auxPrice: leg.stopPrice,
            tif,
            account: accountId,
            parentId: parentOrderId,
            ocaGroup: leg.ocaGroup,
            ocaType: 2,
            // Only the very last child of the very last leg transmits the entire
            // staged batch atomically.
            transmit: isLastLeg,
          };
      ordersList.push({
        orderId: leg.takeProfitOrderId,
        order: takeProfitOrder,
      });
      ordersList.push({ orderId: leg.stopLossOrderId, order: stopLossOrder });
      relatedOrderIds.add(leg.takeProfitOrderId);
      relatedOrderIds.add(leg.stopLossOrderId);
    });

    // The runner pair is always the last entry in `legs`; surface it as the
    // primary bracket for verification/logging consumers that expect a single
    // (tp, sl) pair.
    const runner = legs[legs.length - 1];

    return {
      parentOrderId,
      orders: ordersList,
      relatedOrderIds,
      bracket: {
        takeProfitOrderId: runner.takeProfitOrderId,
        stopLossOrderId: runner.stopLossOrderId,
      },
      bracketLegs: legs,
    };
  }

  /**
   * Builds the per-leg plan for a bracket order. When the ticket has no
   * `partialTakeProfits`, returns a single runner leg covering the full
   * quantity. Otherwise returns one leg per partial rung plus a runner leg
   * for the residual quantity. Each leg gets its own OCA group so that
   * legs are mutually independent.
   */
  private planBracketLegs(ticket: SignalTicket): PlannedBracketLeg[] {
    if (ticket.stop === undefined || ticket.takeProfit === undefined) {
      throw new Error("Bracket leg planning requires stop and takeProfit");
    }

    const totalQty = ticket.quantity;
    const step = Number.isInteger(totalQty) ? 1 : 0.0001;
    const roundDown = (qty: number): number =>
      Math.max(0, Math.floor(qty / step) * step);

    const partials = (ticket.partialTakeProfits ?? []).filter(
      (level) =>
        Number.isFinite(level.fraction) && Number.isFinite(level.price),
    );

    const ocaPrefix = `BR_${this.allocOcaToken()}`;
    const legs: PlannedBracketLeg[] = [];
    let allocatedQty = 0;

    for (let i = 0; i < partials.length; i += 1) {
      const partial = partials[i];
      const remainingQty = totalQty - allocatedQty;
      // Reserve at least one step for the runner so the ladder always has a
      // tail; if rounding leaves no room, drop the partial silently.
      const maxLegQty = remainingQty - step;
      if (maxLegQty < step) break;
      const desired = roundDown(totalQty * partial.fraction);
      const legQty = Math.min(desired, maxLegQty);
      if (legQty < step) continue;

      legs.push({
        takeProfitOrderId: this.allocOrderId(),
        stopLossOrderId: this.allocOrderId(),
        quantity: legQty,
        takeProfitPrice: partial.price,
        stopPrice: ticket.stop,
        ocaGroup: `${ocaPrefix}_p${i + 1}`,
        isPartial: true,
      });
      allocatedQty += legQty;
    }

    const runnerQty = roundDown(totalQty - allocatedQty);
    if (runnerQty < step) {
      throw new Error(
        `Bracket leg planning produced runner qty < step (totalQty=${totalQty}, allocated=${allocatedQty}, step=${step}). ` +
          `Reduce partialTakeProfits fractions or quantity.`,
      );
    }

    legs.push({
      takeProfitOrderId: this.allocOrderId(),
      stopLossOrderId: this.allocOrderId(),
      quantity: runnerQty,
      takeProfitPrice: ticket.takeProfit,
      stopPrice: ticket.stop,
      ocaGroup: `${ocaPrefix}_r`,
      isPartial: false,
    });

    return legs;
  }

  private ocaTokenCounter = 0;
  private allocOcaToken(): string {
    this.ocaTokenCounter += 1;
    // Compact unique token, scoped to this client instance.
    return `${Date.now().toString(36)}_${this.ocaTokenCounter}`;
  }

  private shouldAttachBracket(ticket: SignalTicket): boolean {
    if (ticket.positionEffect === "CLOSE_OR_REDUCE") return false;
    if (ticket.stop === undefined || ticket.takeProfit === undefined)
      return false;
    if (!Number.isFinite(ticket.stop) || !Number.isFinite(ticket.takeProfit))
      return false;
    return true;
  }

  private validateBracket(ticket: SignalTicket): void {
    if (ticket.stop === undefined || ticket.takeProfit === undefined) {
      throw new Error("Bracket order requires stop and takeProfit");
    }
    if (!Number.isFinite(ticket.stop) || !Number.isFinite(ticket.takeProfit)) {
      throw new Error("Bracket order requires finite stop and takeProfit");
    }
    if (ticket.stop <= 0 || ticket.takeProfit <= 0) {
      throw new Error("Bracket order requires positive stop and takeProfit");
    }

    if (
      ticket.side === "BUY" &&
      ticket.entry !== undefined &&
      Number.isFinite(ticket.entry)
    ) {
      if (!(ticket.stop < ticket.entry)) {
        throw new Error(
          `Invalid BUY bracket: stop (${ticket.stop}) must be below entry (${ticket.entry})`,
        );
      }
      if (!(ticket.takeProfit > ticket.entry)) {
        throw new Error(
          `Invalid BUY bracket: takeProfit (${ticket.takeProfit}) must be above entry (${ticket.entry})`,
        );
      }
    }

    if (
      ticket.side === "SELL" &&
      ticket.entry !== undefined &&
      Number.isFinite(ticket.entry)
    ) {
      if (!(ticket.stop > ticket.entry)) {
        throw new Error(
          `Invalid SELL bracket: stop (${ticket.stop}) must be above entry (${ticket.entry})`,
        );
      }
      if (!(ticket.takeProfit < ticket.entry)) {
        throw new Error(
          `Invalid SELL bracket: takeProfit (${ticket.takeProfit}) must be below entry (${ticket.entry})`,
        );
      }
    }

    // Partial-take-profit ladder must sit strictly between the entry and the
    // runner takeProfit, on the correct side of the entry. Cumulative fraction
    // must stay below 1 so the runner always has at least one share.
    if (ticket.partialTakeProfits && ticket.partialTakeProfits.length > 0) {
      const isLong = ticket.side === "BUY";
      let cumulative = 0;
      for (const level of ticket.partialTakeProfits) {
        if (
          !Number.isFinite(level.fraction) ||
          !(level.fraction > 0) ||
          level.fraction >= 1
        ) {
          throw new Error(
            `Invalid partialTakeProfits fraction: ${level.fraction}`,
          );
        }
        if (!Number.isFinite(level.price) || level.price <= 0) {
          throw new Error(`Invalid partialTakeProfits price: ${level.price}`);
        }
        if (ticket.entry !== undefined && Number.isFinite(ticket.entry)) {
          if (
            isLong &&
            !(level.price > ticket.entry && level.price < ticket.takeProfit)
          ) {
            throw new Error(
              `Invalid BUY partial TP: ${level.price} must be between entry (${ticket.entry}) and takeProfit (${ticket.takeProfit})`,
            );
          }
          if (
            !isLong &&
            !(level.price < ticket.entry && level.price > ticket.takeProfit)
          ) {
            throw new Error(
              `Invalid SELL partial TP: ${level.price} must be between entry (${ticket.entry}) and takeProfit (${ticket.takeProfit})`,
            );
          }
        }
        cumulative += level.fraction;
      }
      if (!(cumulative < 1)) {
        throw new Error(
          `partialTakeProfits cumulative fraction must be < 1, got ${cumulative}`,
        );
      }
    }
  }

  private buildParentOrder(
    ticket: SignalTicket,
    accountId: string,
    tif: string,
    transmit: boolean,
  ): Record<string, unknown> {
    if (ticket.side !== "BUY" && ticket.side !== "SELL") {
      throw new Error(`Execution supports BUY/SELL only, got ${ticket.side}`);
    }
    if (ticket.quantity <= 0) {
      throw new Error("Quantity must be > 0");
    }

    const orderType = ticket.orderType.toUpperCase();
    const base: Record<string, unknown> = {
      action: ticket.side,
      totalQuantity: ticket.quantity,
      orderType,
      tif,
      account: accountId,
      transmit,
    };

    if (orderType === "LMT") {
      if (ticket.entry === undefined || !Number.isFinite(ticket.entry)) {
        throw new Error("LMT order requires ticket.entry");
      }
      base.lmtPrice = ticket.entry;
    }
    if (orderType === "STP") {
      if (ticket.entry === undefined || !Number.isFinite(ticket.entry)) {
        throw new Error("STP order requires ticket.entry");
      }
      base.auxPrice = ticket.entry;
    }

    if (orderType !== "MKT" && orderType !== "LMT" && orderType !== "STP") {
      throw new Error(
        `Unsupported orderType for current execution engine: ${ticket.orderType}`,
      );
    }

    return base;
  }

  private async resolveContract(
    ticket: SignalTicket,
  ): Promise<ResolvedContract> {
    if (ticket.conid && Number.isFinite(Number(ticket.conid))) {
      const conId = Number(ticket.conid);
      try {
        return await this.resolveContractByConid(conId, ticket.instrument);
      } catch (error) {
        this.onLog(
          `execution contractDetails fallback for conid=${conId}: ${(error as Error).message}`,
        );
        const fromEnv = this.config.contractFallbackByConid?.[String(conId)];
        const fallbackExchange = fromEnv?.exchange ?? this.config.exchange;
        const fallbackCurrency = fromEnv?.currency ?? this.config.currency;

        // Fallback for sec-def outages/timeouts. Prefer per-conid env overrides, then global defaults.
        return {
          contract: {
            conId,
            symbol: fromEnv?.symbol ?? ticket.instrument,
            secType: fromEnv?.secType ?? this.config.securityType,
            ...(fallbackExchange ? { exchange: fallbackExchange } : {}),
            ...(fromEnv?.primaryExch
              ? { primaryExch: fromEnv.primaryExch }
              : {}),
            ...(fallbackCurrency ? { currency: fallbackCurrency } : {}),
          },
        };
      }
    }

    const reqId = this.allocOrderId() + 100_000;
    const contract = this.withDefaults({ symbol: ticket.instrument });

    return new Promise<ResolvedContract>((resolve, reject) => {
      let firstDetails: ContractDetailsShape | undefined;

      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Timed out waiting contractDetails for ${ticket.instrument}`,
          ),
        );
      }, 8_000);

      const cleanup = () => {
        clearTimeout(timeout);
        this.ib.off("contractDetails", onContractDetails);
        this.ib.off("contractDetailsEnd", onContractDetailsEnd);
        this.ib.off("error", onError);
      };

      const onContractDetails = (
        incomingReqId: number,
        details: ContractDetailsShape,
      ) => {
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
          reject(
            new Error(`No conId in contract details for ${ticket.instrument}`),
          );
          return;
        }

        resolve({
          contract: this.withDefaults({
            conId,
            symbol: String(summary.symbol ?? ticket.instrument),
            secType:
              typeof summary.secType === "string" ? summary.secType : undefined,
            exchange:
              typeof summary.exchange === "string"
                ? summary.exchange
                : undefined,
            currency:
              typeof summary.currency === "string"
                ? summary.currency
                : undefined,
            primaryExch:
              typeof summary.primaryExch === "string"
                ? summary.primaryExch
                : undefined,
          }),
          minTick: this.normalizeMinTick(firstDetails?.minTick),
        });
      };

      const onError = (arg1: unknown, arg2?: unknown, arg3?: unknown) => {
        const parsed = this.parseIbErrorArgs(arg1, arg2, arg3);
        if (parsed.reqId !== undefined && Number(parsed.reqId) !== reqId)
          return;
        cleanup();
        reject(
          new Error(
            `contractDetails error for ${ticket.instrument}: ${parsed.message} (code=${parsed.code ?? "n/a"})`,
          ),
        );
      };

      this.ib.on("contractDetails", onContractDetails);
      this.ib.on("contractDetailsEnd", onContractDetailsEnd);
      this.ib.on("error", onError);
      this.ib.reqContractDetails(reqId, contract);
    });
  }

  private async resolveContractByConid(
    conId: number,
    symbolHint?: string,
  ): Promise<ResolvedContract> {
    const reqId = this.allocOrderId() + 100_000;

    return new Promise<ResolvedContract>((resolve, reject) => {
      let firstDetails: ContractDetailsShape | undefined;

      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(`Timed out waiting contractDetails for conid=${conId}`),
        );
      }, 8_000);

      const cleanup = () => {
        clearTimeout(timeout);
        this.ib.off("contractDetails", onContractDetails);
        this.ib.off("contractDetailsEnd", onContractDetailsEnd);
        this.ib.off("error", onError);
      };

      const onContractDetails = (
        incomingReqId: number,
        details: ContractDetailsShape,
      ) => {
        if (incomingReqId !== reqId) return;
        if (!firstDetails) firstDetails = details;
      };

      const onContractDetailsEnd = (incomingReqId: number) => {
        if (incomingReqId !== reqId) return;
        cleanup();

        const summary = firstDetails?.contract ?? firstDetails?.summary;
        if (!summary) {
          reject(new Error(`No contract details for conid=${conId}`));
          return;
        }

        resolve({
          contract: {
            conId,
            symbol: String(summary.symbol ?? symbolHint ?? ""),
            secType:
              typeof summary.secType === "string"
                ? summary.secType
                : this.config.securityType,
            exchange:
              typeof summary.exchange === "string"
                ? summary.exchange
                : undefined,
            primaryExch:
              typeof summary.primaryExch === "string"
                ? summary.primaryExch
                : undefined,
            currency:
              typeof summary.currency === "string"
                ? summary.currency
                : undefined,
          },
          minTick: this.normalizeMinTick(firstDetails?.minTick),
        });
      };

      const onError = (arg1: unknown, arg2?: unknown, arg3?: unknown) => {
        const parsed = this.parseIbErrorArgs(arg1, arg2, arg3);
        if (parsed.reqId !== undefined && Number(parsed.reqId) !== reqId)
          return;
        cleanup();
        reject(
          new Error(
            `contractDetails error for conid=${conId}: ${parsed.message} (code=${parsed.code ?? "n/a"})`,
          ),
        );
      };

      this.ib.on("contractDetails", onContractDetails);
      this.ib.on("contractDetailsEnd", onContractDetailsEnd);
      this.ib.on("error", onError);
      this.ib.reqContractDetails(reqId, { conId });
    });
  }

  private withDefaults(contract: ContractShape): ContractShape {
    return {
      secType: this.config.securityType,
      exchange: this.config.exchange,
      currency: this.config.currency,
      ...(this.config.primaryExchange
        ? { primaryExch: this.config.primaryExchange }
        : {}),
      ...contract,
    };
  }

  private normalizeMinTick(value: unknown): number | undefined {
    const parsed = toNum(value);
    if (parsed === undefined || !Number.isFinite(parsed) || parsed <= 0)
      return undefined;
    return parsed;
  }

  private determineEffectiveTick(
    contract: ContractShape,
    ticket: SignalTicket,
    rawMinTick?: number,
  ): EffectiveTick {
    const validMinTick =
      rawMinTick && Number.isFinite(rawMinTick) && rawMinTick > 0
        ? rawMinTick
        : undefined;
    const fallbackRefPrice = ticket.entry ?? ticket.stop ?? ticket.takeProfit;
    const refPrice =
      typeof fallbackRefPrice === "number" && Number.isFinite(fallbackRefPrice)
        ? fallbackRefPrice
        : undefined;

    if (
      this.isWseContract(contract) &&
      refPrice !== undefined &&
      refPrice > 0
    ) {
      const ladderTick = this.wseTickForPrice(refPrice);
      if (validMinTick === undefined || validMinTick < ladderTick) {
        return { tick: ladderTick, source: "wse_ladder" };
      }
      return { tick: validMinTick, source: "minTick" };
    }

    // SEC Rule 612 (sub-penny rule): US-listed stocks priced >= $1.00
    // must trade in $0.01 increments for LIMIT orders, even though
    // IBKR contractDetails may report a finer minTick (e.g. 0.0001 for
    // RIOT). Override to the legal increment to avoid cancel code 110.
    if (this.isUsStockContract(contract)) {
      const ref = refPrice && refPrice > 0 ? refPrice : 1;
      const secTick = ref >= 1 ? 0.01 : 0.0001;
      if (validMinTick === undefined || validMinTick < secTick) {
        return { tick: secTick, source: "us_sec612" };
      }
      return { tick: validMinTick, source: "minTick" };
    }

    if (validMinTick !== undefined) {
      return { tick: validMinTick, source: "minTick" };
    }
    return { source: "none" };
  }

  private isUsStockContract(contract: ContractShape): boolean {
    const currency = (contract.currency ?? "").toUpperCase();
    const secType = (contract.secType ?? "").toUpperCase();
    if (currency !== "USD") return false;
    if (secType && secType !== "STK") return false;
    return true;
  }

  private enforceIntegerQuantityIfNeeded(ticket: SignalTicket): SignalTicket {
    const qty = Number(ticket.quantity);
    if (!Number.isFinite(qty) || qty <= 0) return ticket;
    const symbol = String(ticket.instrument ?? "").toUpperCase();
    const fractionalAllowed =
      this.config.fractionalSymbols?.has(symbol) === true;
    if (fractionalAllowed) return ticket;
    if (Number.isInteger(qty)) return ticket;
    const floored = Math.floor(qty);
    if (floored <= 0) {
      throw new Error(
        `Quantity guard: ${symbol} not in fractional whitelist and qty=${qty} floors to 0`,
      );
    }
    this.onLog(
      `execution quantity floored symbol=${symbol} ${qty}->${floored} (non-fractional)`,
    );
    return { ...ticket, quantity: floored };
  }

  private assertUsRthAllows(
    contract: ContractShape,
    ticket: SignalTicket,
  ): void {
    if (this.config.blockOutsideUsRth !== true) return;
    if (!this.isUsStockContract(contract)) return;
    // Always permit exits — we must be able to close positions when
    // an early-warning trigger fires outside RTH.
    if (ticket.positionEffect === "CLOSE_OR_REDUCE") return;

    const openBufferMin = Math.max(0, this.config.usRthOpenBufferMin ?? 0);
    const closeBufferMin = Math.max(0, this.config.usRthCloseBufferMin ?? 10);
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false,
    }).formatToParts(now);

    const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");

    if (weekday === "Sat" || weekday === "Sun") {
      throw new Error(
        `US RTH guard: weekend (${weekday}) — order rejected for ${ticket.instrument}`,
      );
    }

    const minutesOfDay = hour * 60 + minute;
    const openMin = 9 * 60 + 30 + openBufferMin;
    const closeMin = 16 * 60 - closeBufferMin;

    if (minutesOfDay < openMin || minutesOfDay >= closeMin) {
      throw new Error(
        `US RTH guard: outside window ${String(Math.floor(openMin / 60)).padStart(2, "0")}:${String(openMin % 60).padStart(2, "0")}-${String(Math.floor(closeMin / 60)).padStart(2, "0")}:${String(closeMin % 60).padStart(2, "0")} ET (now ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} ET) — order rejected for ${ticket.instrument}`,
      );
    }
  }

  private isWseContract(contract: ContractShape): boolean {
    const values = [contract.exchange, contract.primaryExch]
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.toUpperCase());

    return values.some(
      (value) =>
        value === "WSE" || value.includes("WARSAW") || value.includes("GPW"),
    );
  }

  private wseTickForPrice(price: number): number {
    if (price < 50) return 0.01;
    if (price < 100) return 0.02;
    // CDR-like names in this band are rejected by broker on 0.05 stop ticks (code=110),
    // so use a coarser 0.1 ladder step for 100-500 PLN.
    if (price < 500) return 0.1;
    if (price < 1000) return 0.1;
    if (price < 2000) return 0.5;
    return 1;
  }

  private wasTicketNormalized(
    original: SignalTicket,
    normalized: SignalTicket,
  ): boolean {
    const different = (a?: number, b?: number): boolean => {
      if (a === undefined && b === undefined) return false;
      if (a === undefined || b === undefined) return true;
      return Math.abs(a - b) > 1e-12;
    };

    return (
      different(original.entry, normalized.entry) ||
      different(original.stop, normalized.stop) ||
      different(original.takeProfit, normalized.takeProfit)
    );
  }

  private normalizeTicketPrices(
    ticket: SignalTicket,
    minTick?: number,
  ): SignalTicket {
    if (!minTick || !Number.isFinite(minTick) || minTick <= 0) {
      return ticket;
    }

    const normalized: SignalTicket = { ...ticket };
    const isBuy = ticket.side === "BUY";

    if (ticket.entry !== undefined && Number.isFinite(ticket.entry)) {
      if (ticket.orderType === "LMT") {
        normalized.entry = this.roundToTick(
          ticket.entry,
          minTick,
          isBuy ? "down" : "up",
        );
      }
      if (ticket.orderType === "STP") {
        normalized.entry = this.roundToTick(
          ticket.entry,
          minTick,
          isBuy ? "up" : "down",
        );
      }
    }

    if (ticket.stop !== undefined && Number.isFinite(ticket.stop)) {
      normalized.stop = this.roundToTick(
        ticket.stop,
        minTick,
        isBuy ? "down" : "up",
      );
    }

    if (ticket.takeProfit !== undefined && Number.isFinite(ticket.takeProfit)) {
      normalized.takeProfit = this.roundToTick(
        ticket.takeProfit,
        minTick,
        isBuy ? "up" : "down",
      );
    }

    if (normalized.stop !== undefined && normalized.stop <= 0) {
      normalized.stop = minTick;
    }
    if (normalized.takeProfit !== undefined && normalized.takeProfit <= 0) {
      normalized.takeProfit = minTick;
    }

    if (ticket.side === "BUY" && normalized.entry !== undefined) {
      if (
        normalized.stop !== undefined &&
        normalized.stop >= normalized.entry
      ) {
        normalized.stop = Math.max(
          minTick,
          this.roundToTick(normalized.entry - minTick, minTick, "down"),
        );
      }
      if (
        normalized.takeProfit !== undefined &&
        normalized.takeProfit <= normalized.entry
      ) {
        normalized.takeProfit = this.roundToTick(
          normalized.entry + minTick,
          minTick,
          "up",
        );
      }
    }

    if (ticket.side === "SELL" && normalized.entry !== undefined) {
      if (
        normalized.stop !== undefined &&
        normalized.stop <= normalized.entry
      ) {
        normalized.stop = this.roundToTick(
          normalized.entry + minTick,
          minTick,
          "up",
        );
      }
      if (
        normalized.takeProfit !== undefined &&
        normalized.takeProfit >= normalized.entry
      ) {
        normalized.takeProfit = Math.max(
          minTick,
          this.roundToTick(normalized.entry - minTick, minTick, "down"),
        );
      }
    }

    return normalized;
  }

  private roundToTick(
    price: number,
    minTick: number,
    direction: "down" | "up",
  ): number {
    if (!Number.isFinite(price)) return price;

    const decimals = this.decimalPlaces(minTick);
    const epsilon = minTick * 1e-9;
    const stepsRaw = price / minTick;
    const steps =
      direction === "down"
        ? Math.floor(stepsRaw + epsilon)
        : Math.ceil(stepsRaw - epsilon);
    const rounded = steps * minTick;

    return Number(rounded.toFixed(Math.min(Math.max(decimals, 2), 8)));
  }

  private decimalPlaces(value: number): number {
    const normalized = String(value).toLowerCase();
    if (normalized.includes("e-")) {
      const [, exponent] = normalized.split("e-");
      const parsed = Number(exponent);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
      return 8;
    }
    const dot = normalized.indexOf(".");
    if (dot === -1) return 0;
    return normalized.length - dot - 1;
  }

  private buildAccountSnapshot(
    accountId: string,
    valuesByKey: Map<string, Map<string, string>>,
    positionsByKey: Map<string, AccountPositionSnapshot>,
    accountTime?: string,
  ): AccountSnapshot {
    const positions = Array.from(positionsByKey.values()).sort((a, b) =>
      a.symbol.localeCompare(b.symbol),
    );

    let longExposure = 0;
    let shortExposure = 0;

    for (const position of positions) {
      const mv = position.marketValue ?? 0;
      if (mv >= 0) longExposure += mv;
      else shortExposure += Math.abs(mv);
    }

    const metrics: AccountMetricSet = {
      netLiquidation: this.pickAccountMetric(valuesByKey, "NetLiquidation"),
      totalCashValue: this.pickAccountMetric(valuesByKey, "TotalCashValue"),
      settledCash: this.pickAccountMetric(valuesByKey, "SettledCash"),
      buyingPower: this.pickAccountMetric(valuesByKey, "BuyingPower"),
      availableFunds: this.pickAccountMetric(valuesByKey, "AvailableFunds"),
      excessLiquidity: this.pickAccountMetric(valuesByKey, "ExcessLiquidity"),
      equityWithLoanValue: this.pickAccountMetric(
        valuesByKey,
        "EquityWithLoanValue",
      ),
      grossPositionValue: this.pickAccountMetric(
        valuesByKey,
        "GrossPositionValue",
      ),
      initMarginReq: this.pickAccountMetric(valuesByKey, "InitMarginReq"),
      maintMarginReq: this.pickAccountMetric(valuesByKey, "MaintMarginReq"),
      unrealizedPnL: this.pickAccountMetric(valuesByKey, "UnrealizedPnL"),
      realizedPnL: this.pickAccountMetric(valuesByKey, "RealizedPnL"),
      cushion: this.pickAccountMetric(valuesByKey, "Cushion"),
    };

    const baseCurrency = this.config.currency.trim().toUpperCase();
    const pnlFxToBaseByCurrency = this.buildPnLFxToBaseByCurrency(
      valuesByKey,
      positions,
      baseCurrency,
      metrics.unrealizedPnL,
    );
    let unrealizedPnLFromPositionsBase = 0;
    let realizedPnLFromPositionsBase = 0;

    for (const position of positions) {
      const currency = position.currency?.trim().toUpperCase();
      const fxToBase = currency
        ? pnlFxToBaseByCurrency.get(currency)
        : undefined;

      if (
        fxToBase !== undefined &&
        position.unrealizedPnL !== undefined &&
        Number.isFinite(position.unrealizedPnL)
      ) {
        const value = position.unrealizedPnL * fxToBase;
        position.unrealizedPnLBase = value;
        unrealizedPnLFromPositionsBase += value;
      }

      if (
        fxToBase !== undefined &&
        position.realizedPnL !== undefined &&
        Number.isFinite(position.realizedPnL)
      ) {
        const value = position.realizedPnL * fxToBase;
        position.realizedPnLBase = value;
        realizedPnLFromPositionsBase += value;
      }
    }

    return {
      accountId,
      retrievedAt: new Date().toISOString(),
      accountTime,
      fxToBaseByCurrency: Object.fromEntries(pnlFxToBaseByCurrency),
      metrics,
      totals: {
        positionsCount: positions.length,
        longExposure,
        shortExposure,
        grossExposure: longExposure + shortExposure,
        netExposure: longExposure - shortExposure,
        unrealizedPnL: metrics.unrealizedPnL ?? unrealizedPnLFromPositionsBase,
        realizedPnL: metrics.realizedPnL ?? realizedPnLFromPositionsBase,
      },
      positions,
    };
  }

  private buildPnLFxToBaseByCurrency(
    valuesByKey: Map<string, Map<string, string>>,
    positions: AccountPositionSnapshot[],
    baseCurrency: string,
    targetUnrealizedBase?: number,
  ): Map<string, number> {
    const normalizedBaseCurrency = baseCurrency.trim().toUpperCase();
    const byCurrencyLocalUnrealized = new Map<string, number>();
    for (const position of positions) {
      const currency = position.currency?.trim().toUpperCase();
      if (!currency) continue;
      const current = byCurrencyLocalUnrealized.get(currency) ?? 0;
      byCurrencyLocalUnrealized.set(
        currency,
        current + (position.unrealizedPnL ?? 0),
      );
    }

    const out = new Map<string, number>([[normalizedBaseCurrency, 1]]);

    const exchangeRates = valuesByKey.get("ExchangeRate");
    if (!exchangeRates || byCurrencyLocalUnrealized.size === 0) {
      return out;
    }

    const candidates = Array.from(byCurrencyLocalUnrealized.entries())
      .filter(([currency]) => currency !== normalizedBaseCurrency)
      .map(([currency, localUnrealized]) => ({
        currency,
        localUnrealized,
        rawRate: toNum(exchangeRates.get(currency)),
      }))
      .filter(
        (entry) =>
          entry.rawRate !== undefined &&
          Number.isFinite(entry.rawRate) &&
          (entry.rawRate as number) > 0,
      );

    if (candidates.length === 0) {
      return out;
    }

    const baseLocalUnrealized =
      byCurrencyLocalUnrealized.get(normalizedBaseCurrency) ?? 0;
    const target = Number.isFinite(targetUnrealizedBase ?? NaN)
      ? Number(targetUnrealizedBase) - baseLocalUnrealized
      : undefined;
    const combos = candidates.length <= 10 ? 1 << candidates.length : 0;

    if (target === undefined || combos === 0) {
      for (const entry of candidates) {
        const rawRate = entry.rawRate as number;
        const heuristic = rawRate > 1 ? 1 / rawRate : rawRate;
        out.set(entry.currency, heuristic);
      }
      return out;
    }

    let bestMask = 0;
    let bestError = Number.POSITIVE_INFINITY;

    for (let mask = 0; mask < combos; mask += 1) {
      let convertedTotal = 0;

      for (let i = 0; i < candidates.length; i += 1) {
        const candidate = candidates[i];
        const rawRate = candidate.rawRate as number;
        const useRaw = (mask & (1 << i)) !== 0;
        const fxToBase = useRaw ? rawRate : 1 / rawRate;
        convertedTotal += candidate.localUnrealized * fxToBase;
      }

      const error = Math.abs(convertedTotal - target);
      if (error < bestError) {
        bestError = error;
        bestMask = mask;
      }
    }

    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      const rawRate = candidate.rawRate as number;
      const useRaw = (bestMask & (1 << i)) !== 0;
      const fxToBase = useRaw ? rawRate : 1 / rawRate;
      out.set(candidate.currency, fxToBase);
    }

    return out;
  }

  private pickAccountMetric(
    valuesByKey: Map<string, Map<string, string>>,
    key: string,
  ): number | undefined {
    const byCurrency = valuesByKey.get(key);
    if (!byCurrency) return undefined;

    const candidate =
      byCurrency.get("BASE") ??
      byCurrency.get("USD") ??
      Array.from(byCurrency.values())[0];
    return toNum(candidate);
  }

  private bindCoreListeners(): void {
    this.ib.on("connected", () => {
      this.onLog("execution socket connected event received");
    });

    this.ib.on("disconnected", () => {
      this.onLog("execution socket disconnected");
      this.connected = false;
      this.clearAllSubmittedAutoCancelTimers();
      this.clearAllBracketVerificationTimers();
    });

    this.ib.on("error", (arg1: unknown, arg2?: unknown, arg3?: unknown) => {
      const parsed = this.parseIbErrorArgs(arg1, arg2, arg3);
      const prefix =
        parsed.reqId !== undefined ? `reqId=${parsed.reqId}` : "reqId=n/a";
      this.onLog(
        `execution TWS error code=${parsed.code ?? "n/a"} ${prefix}: ${parsed.message}`,
      );

      const reqId = Number(parsed.reqId);
      const code = Number(parsed.code);
      if (!Number.isFinite(reqId) || !Number.isFinite(code)) return;
      if (code === 399) {
        const warning = parsed.message.trim();
        const existing = this.brokerOrderWarnings.get(reqId) ?? [];
        if (warning && !existing.includes(warning)) {
          existing.push(warning);
          this.brokerOrderWarnings.set(reqId, existing);
        }
        return;
      }
      if (code !== 404) return;

      const context = this.openOrderContext.get(reqId);
      if (!context) return;
      if (!this.shouldAutoCancelLocateHeld(context, parsed.message)) return;
      if (this.locateAutoCancelAttempted.has(reqId)) return;

      this.locateAutoCancelAttempted.add(reqId);
      this.onLog(
        `execution auto-cancel locate-held orderId=${reqId} symbol=${context.symbol} side=${context.side} positionEffect=${context.positionEffect ?? "n/a"}`,
      );

      void this.cancelBrokerOrder(String(reqId))
        .then((result) => {
          this.onLog(
            `execution auto-cancel locate-held result orderId=${reqId} status=${result.status}`,
          );
          if (result.status === "CANCELLED") {
            this.onBrokerOrderStatus?.({
              brokerOrderId: String(reqId),
              status: "CANCELLED",
              message: this.buildCancelMessage(
                reqId,
                `Auto-cancelled locate-held short (code=404): ${parsed.message}`,
              ),
            });
          }
        })
        .catch((error) => {
          const message = (error as Error).message;
          this.onLog(
            `execution auto-cancel locate-held failed orderId=${reqId}: ${message}`,
          );

          // If broker reports "not found", treat as terminal and close local record.
          if (message.includes("code=10147")) {
            this.onBrokerOrderStatus?.({
              brokerOrderId: String(reqId),
              status: "CANCELLED",
              message: this.buildCancelMessage(
                reqId,
                `Auto-cancel locate-held: broker reports order not found (code=10147). Original error: ${message}`,
              ),
            });
          }
        });
    });

    this.ib.on(
      "orderStatus",
      (orderId: number, status: string, filled: number, remaining: number) => {
        const normalized = String(status || "").toUpperCase();
        this.orderStatusById.set(orderId, normalized);
        this.onLog(
          `execution orderStatus orderId=${orderId} status=${normalized} filled=${filled} remaining=${remaining}`,
        );
        this.onBrokerOrderStatus?.({
          brokerOrderId: String(orderId),
          status: normalized,
          message: `Broker order status update: ${normalized} (filled=${filled}, remaining=${remaining})`,
        });

        const context = this.openOrderContext.get(orderId);

        if (
          context?.role === "parent" &&
          (normalized === "SUBMITTED" ||
            normalized === "PRESUBMITTED" ||
            normalized === "PENDINGSUBMIT")
        ) {
          this.scheduleSubmittedAutoCancel(orderId);
        }

        if (normalized === "PENDINGCANCEL") {
          this.clearSubmittedAutoCancelTimer(orderId);
        }

        if (context?.role === "parent" && normalized === "FILLED") {
          this.scheduleBracketVerification(orderId);
        }

        if (
          normalized === "FILLED" ||
          normalized === "CANCELLED" ||
          normalized === "APICANCELLED" ||
          normalized === "INACTIVE"
        ) {
          this.clearParentOrderContext(orderId);
        }
      },
    );

    this.ib.on(
      "execDetails",
      (
        reqId: number,
        contract: ContractShape,
        exec: Record<string, unknown>,
      ) => {
        const sideRaw = String(exec.side ?? "")
          .trim()
          .toUpperCase();
        const side =
          sideRaw === "BOT" || sideRaw === "BUY"
            ? "BUY"
            : sideRaw === "SLD" || sideRaw === "SELL"
              ? "SELL"
              : null;
        const execId = String(exec.execId ?? "").trim();
        const shares = toNum(exec.shares);
        const price = toNum(exec.price);
        if (
          !execId ||
          !side ||
          !Number.isFinite(shares) ||
          !Number.isFinite(price)
        )
          return;

        this.onBrokerExecutionFill?.({
          execId,
          orderId: toNum(exec.orderId),
          accountId:
            typeof exec.acctNumber === "string" ? exec.acctNumber : undefined,
          conid: Number.isFinite(toNum(contract.conId))
            ? String(toNum(contract.conId))
            : undefined,
          symbol: String(contract.symbol ?? "UNKNOWN"),
          currency:
            typeof contract.currency === "string"
              ? contract.currency
              : undefined,
          exchange:
            typeof exec.exchange === "string"
              ? exec.exchange
              : typeof contract.exchange === "string"
                ? contract.exchange
                : undefined,
          side,
          shares: Number(shares),
          price: Number(price),
          avgPrice: toNum(exec.avgPrice),
          executedAt: typeof exec.time === "string" ? exec.time : undefined,
        });
      },
    );

    this.ib.on("commissionReport", (report: Record<string, unknown>) => {
      const execId = String(report.execId ?? "").trim();
      if (!execId) return;

      this.onBrokerCommissionReport?.({
        execId,
        commission: toNum(report.commission),
        currency:
          typeof report.currency === "string" ? report.currency : undefined,
        realizedPnL: toBrokerRealizedPnl(report.realizedPNL),
      });
    });
  }

  private allocRequestId(): number {
    this.nextRequestId += 1;
    return this.nextRequestId;
  }

  private formatExecutionFilterTime(value: Date): string {
    const year = value.getUTCFullYear();
    const month = String(value.getUTCMonth() + 1).padStart(2, "0");
    const day = String(value.getUTCDate()).padStart(2, "0");
    const hour = String(value.getUTCHours()).padStart(2, "0");
    const minute = String(value.getUTCMinutes()).padStart(2, "0");
    const second = String(value.getUTCSeconds()).padStart(2, "0");
    return `${year}${month}${day}-${hour}:${minute}:${second}`;
  }

  private trackOrderPlanContext(
    plan: PlaceOrderPlan,
    ticket: SignalTicket,
  ): void {
    this.openOrderContext.set(plan.parentOrderId, {
      symbol: ticket.instrument,
      side: ticket.side,
      positionEffect: ticket.positionEffect,
      role: "parent",
    });

    if (!plan.bracket) return;

    this.openOrderContext.set(plan.bracket.takeProfitOrderId, {
      symbol: ticket.instrument,
      side: ticket.side,
      positionEffect: ticket.positionEffect,
      role: "take_profit",
      parentOrderId: plan.parentOrderId,
    });

    this.openOrderContext.set(plan.bracket.stopLossOrderId, {
      symbol: ticket.instrument,
      side: ticket.side,
      positionEffect: ticket.positionEffect,
      role: "stop_loss",
      parentOrderId: plan.parentOrderId,
    });

    // Register every partial leg's TP/STOP children so status callbacks can
    // resolve them back to this parent. The runner pair above is already
    // registered; partial legs (if any) live alongside it.
    if (plan.bracketLegs) {
      for (const leg of plan.bracketLegs) {
        if (leg.takeProfitOrderId === plan.bracket.takeProfitOrderId) continue;
        this.openOrderContext.set(leg.takeProfitOrderId, {
          symbol: ticket.instrument,
          side: ticket.side,
          positionEffect: ticket.positionEffect,
          role: "take_profit",
          parentOrderId: plan.parentOrderId,
        });
        this.openOrderContext.set(leg.stopLossOrderId, {
          symbol: ticket.instrument,
          side: ticket.side,
          positionEffect: ticket.positionEffect,
          role: "stop_loss",
          parentOrderId: plan.parentOrderId,
        });
      }
    }

    this.bracketPlansByParent.set(plan.parentOrderId, {
      symbol: ticket.instrument,
      takeProfitOrderId: plan.bracket.takeProfitOrderId,
      stopLossOrderId: plan.bracket.stopLossOrderId,
    });
  }

  private clearParentOrderContext(orderId: number): void {
    this.openOrderContext.delete(orderId);
    this.locateAutoCancelAttempted.delete(orderId);
    this.brokerOrderWarnings.delete(orderId);
    this.clearSubmittedAutoCancelTimer(orderId);
  }

  private scheduleSubmittedAutoCancel(orderId: number): void {
    const context = this.openOrderContext.get(orderId);
    if (context?.role !== "parent") return;

    const timeoutMs = Number(this.config.submittedAutoCancelMs ?? 0);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
    if (this.submittedAutoCancelTimers.has(orderId)) return;

    const timer = setTimeout(() => {
      this.submittedAutoCancelTimers.delete(orderId);
      this.onLog(
        `execution submitted-timeout auto-cancel orderId=${orderId} after=${timeoutMs}ms`,
      );
      const cancelMessage = this.buildCancelMessage(
        orderId,
        `Auto-cancel submitted-timeout after ${timeoutMs}ms without fill`,
      );

      void this.cancelBrokerOrder(String(orderId))
        .then((result) => {
          this.onLog(
            `execution submitted-timeout auto-cancel result orderId=${orderId} status=${result.status}`,
          );
          if (result.status === "CANCELLED") {
            this.onBrokerOrderStatus?.({
              brokerOrderId: String(orderId),
              status: "CANCELLED",
              message: cancelMessage,
            });
          }
        })
        .catch((error) => {
          const message = (error as Error).message;
          this.onLog(
            `execution submitted-timeout auto-cancel failed orderId=${orderId}: ${message}`,
          );

          // If broker reports "not found", close local record as cancelled.
          if (message.includes("code=10147")) {
            this.onBrokerOrderStatus?.({
              brokerOrderId: String(orderId),
              status: "CANCELLED",
              message: this.buildCancelMessage(
                orderId,
                `Auto-cancel submitted-timeout: broker reports order not found (code=10147). Original error: ${message}`,
              ),
            });
          }
        });
    }, timeoutMs);

    this.submittedAutoCancelTimers.set(orderId, timer);
  }

  private clearSubmittedAutoCancelTimer(orderId: number): void {
    const timer = this.submittedAutoCancelTimers.get(orderId);
    if (!timer) return;
    clearTimeout(timer);
    this.submittedAutoCancelTimers.delete(orderId);
  }

  private clearAllSubmittedAutoCancelTimers(): void {
    for (const timer of this.submittedAutoCancelTimers.values()) {
      clearTimeout(timer);
    }
    this.submittedAutoCancelTimers.clear();
  }

  private scheduleBracketVerification(parentOrderId: number): void {
    const bracket = this.bracketPlansByParent.get(parentOrderId);
    if (!bracket) return;
    if (this.bracketVerificationTimers.has(parentOrderId)) return;

    const timer = setTimeout(() => {
      this.bracketVerificationTimers.delete(parentOrderId);

      const takeProfitStatus = this.orderStatusById.get(
        bracket.takeProfitOrderId,
      );
      const stopLossStatus = this.orderStatusById.get(bracket.stopLossOrderId);
      const takeProfitOk = this.isProtectiveOrderActiveOrDone(takeProfitStatus);
      const stopLossOk = this.isProtectiveOrderActiveOrDone(stopLossStatus);

      if (takeProfitOk && stopLossOk) {
        this.onLog(
          `execution bracket verified parent=${parentOrderId} symbol=${bracket.symbol} tp=${bracket.takeProfitOrderId}:${takeProfitStatus} sl=${bracket.stopLossOrderId}:${stopLossStatus}`,
        );
        return;
      }

      const message = `Bracket verification warning: protective child order not active for parent=${parentOrderId}, symbol=${bracket.symbol}, tp=${bracket.takeProfitOrderId}:${takeProfitStatus ?? "missing"}, sl=${bracket.stopLossOrderId}:${stopLossStatus ?? "missing"}`;
      this.onLog(`execution ${message}`);
      this.onBrokerOrderStatus?.({
        brokerOrderId: String(parentOrderId),
        status: "FILLED",
        message,
      });
    }, 5_000);

    this.bracketVerificationTimers.set(parentOrderId, timer);
  }

  private isProtectiveOrderActiveOrDone(status: string | undefined): boolean {
    return (
      status === "SUBMITTED" ||
      status === "PRESUBMITTED" ||
      status === "PENDINGSUBMIT" ||
      status === "FILLED"
    );
  }

  private clearAllBracketVerificationTimers(): void {
    for (const timer of this.bracketVerificationTimers.values()) {
      clearTimeout(timer);
    }
    this.bracketVerificationTimers.clear();
  }

  private buildCancelMessage(orderId: number, baseMessage: string): string {
    const warning = this.brokerOrderWarnings.get(orderId)?.[0];
    if (!warning) return baseMessage;
    return `${baseMessage} | broker_warning: ${warning}`;
  }

  private shouldAutoCancelLocateHeld(
    context: OpenOrderContext,
    message: string,
  ): boolean {
    if (context.side !== "SELL") return false;
    if (context.positionEffect === "CLOSE_OR_REDUCE") return false;
    const normalized = message.toLowerCase();
    return (
      normalized.includes("held while securities are located") ||
      normalized.includes("securities are located")
    );
  }

  private parseIbErrorArgs(
    arg1: unknown,
    arg2?: unknown,
    arg3?: unknown,
  ): { code?: number | string; reqId?: number | string; message: string } {
    let code: number | string | undefined;
    let reqId: number | string | undefined;
    let message = "unknown IB error";

    if (typeof arg1 === "string") {
      message = arg1;
    } else if (arg1 instanceof Error) {
      message = arg1.message;
    } else if (arg1 && typeof arg1 === "object") {
      const obj = arg1 as Record<string, unknown>;
      if (obj.message !== undefined) message = String(obj.message);
      if (obj.code !== undefined) code = String(obj.code);
      if (obj.reqId !== undefined) reqId = String(obj.reqId);
      if (obj.id !== undefined && reqId === undefined) reqId = String(obj.id);
      if (obj.errorCode !== undefined && code === undefined)
        code = String(obj.errorCode);
    }

    if (typeof arg2 === "number" || typeof arg2 === "string") {
      code = arg2;
    } else if (arg2 && typeof arg2 === "object") {
      const obj = arg2 as Record<string, unknown>;
      if (obj.code !== undefined) code = String(obj.code);
      if (obj.errorCode !== undefined && code === undefined)
        code = String(obj.errorCode);
      if (obj.reqId !== undefined && reqId === undefined)
        reqId = String(obj.reqId);
      if (obj.id !== undefined && reqId === undefined) reqId = String(obj.id);
    }

    if (typeof arg3 === "number" || typeof arg3 === "string") {
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
