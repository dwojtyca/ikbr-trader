import Fastify from 'fastify';
import { Pool } from 'pg';
import { z } from 'zod';
import { ProposedOrder, ProposedOrderStatus, SignalTicket } from '@ikbr/shared';
import { config } from './config.js';
import { ExecutionRepository, OrderListFilters } from './repository.js';
import { AccountSnapshot, TwsExecutionClient } from './tws-execution-client.js';

const app = Fastify({ logger: { level: config.LOG_LEVEL } });
const pool = new Pool({ connectionString: config.POSTGRES_URL });
const repo = new ExecutionRepository(pool);
const tws = new TwsExecutionClient(
  {
    host: config.IB_SOCKET_HOST,
    port: config.IB_SOCKET_PORT,
    clientId: config.EXECUTION_CLIENT_ID,
    securityType: config.IB_SECURITY_TYPE,
    exchange: config.IB_EXCHANGE,
    primaryExchange: config.IB_PRIMARY_EXCHANGE,
    currency: config.IB_CURRENCY,
    orderTimeoutMs: config.EXECUTION_ORDER_TIMEOUT_MS
  },
  (line) => app.log.info(line),
  (update) => {
    void repo.applyBrokerStatusUpdate(update).catch((err) => {
      app.log.warn({ update, err }, 'failed to apply broker order status update');
    });
  }
);

const ticketSchema = z.object({
  instrument: z.string().min(1),
  conid: z.string().optional(),
  side: z.enum(['BUY', 'SELL', 'HOLD']),
  positionEffect: z.enum(['OPEN_OR_ADD', 'CLOSE_OR_REDUCE']).optional(),
  orderType: z.enum(['MKT', 'LMT']).default('MKT'),
  quantity: z.coerce.number().positive(),
  entry: z.coerce.number().optional(),
  stop: z.coerce.number().optional(),
  takeProfit: z.coerce.number().optional(),
  reason: z.string().default('manual execution ticket'),
  confidence: z.coerce.number().min(0).max(1).default(0.5),
  timestamp: z.string().default(() => new Date().toISOString()),
  riskCheckStatus: z.enum(['PASS', 'REJECT']).default('PASS')
});

const executeTicketBodySchema = z.object({
  ticket: ticketSchema,
  persist: z.boolean().default(true),
  strategy: z.string().default('manual_ticket'),
  dryRun: z.boolean().optional()
});

let accountSnapshotCache: { accountId: string; fetchedAtMs: number; snapshot: AccountSnapshot } | null = null;

function validateExecutableTicket(ticket: SignalTicket): string | null {
  if (ticket.riskCheckStatus !== 'PASS') {
    return 'riskCheckStatus must be PASS for execution';
  }

  if (ticket.side !== 'BUY' && ticket.side !== 'SELL') {
    return `unsupported side for execution: ${ticket.side}`;
  }

  if (!(ticket.quantity > 0)) {
    return 'quantity must be greater than 0';
  }

  if (ticket.orderType === 'LMT' && (ticket.entry === undefined || !Number.isFinite(ticket.entry))) {
    return 'LMT order requires entry price';
  }

  return null;
}

async function ensureBrokerSession(): Promise<{ accountId: string; accounts: string[] }> {
  await tws.connect();
  const accounts = await tws.getManagedAccounts();

  const accountId = config.IBKR_ACCOUNT_ID ?? accounts[0];
  if (!accountId) {
    throw new Error('No account available from TWS managed accounts for execution');
  }

  if (config.IBKR_ACCOUNT_ID && !accounts.includes(config.IBKR_ACCOUNT_ID)) {
    throw new Error(`Configured IBKR_ACCOUNT_ID=${config.IBKR_ACCOUNT_ID} is not in managed accounts`);
  }

  return { accountId, accounts };
}

async function executePersistedOrder(order: ProposedOrder, dryRun: boolean): Promise<{
  execution: {
    orderId: number;
    accountId: string;
    brokerOrderId: string;
    status: string;
    dryRun: boolean;
  };
}> {
  if (!order.id) {
    throw new Error('persisted order id is missing');
  }

  const validationError = validateExecutableTicket(order);
  if (validationError) {
    await repo.markRejected(order.id, validationError);
    throw new Error(validationError);
  }

  const { accountId } = await ensureBrokerSession();
  await repo.markExecutionAttempt(order.id, accountId);

  if (dryRun) {
    const fakeBrokerOrderId = `DRYRUN-${order.id}`;
    await repo.markCancelled(order.id, 'Dry run: order accepted but not sent to broker');

    return {
      execution: {
        orderId: order.id,
        accountId,
        brokerOrderId: fakeBrokerOrderId,
        status: 'CANCELLED',
        dryRun: true
      }
    };
  }

  try {
    const result = await tws.placeSignalOrder(order, accountId, config.EXECUTION_DEFAULT_TIF);
    if (result.status === 'FILLED') {
      await repo.markFilled(order.id, accountId, result.brokerOrderId, `Broker accepted order, status=${result.status}`);
    } else {
      await repo.markSubmitted(order.id, accountId, result.brokerOrderId, `Broker accepted order, status=${result.status}`);
    }

    return {
      execution: {
        orderId: order.id,
        accountId,
        brokerOrderId: result.brokerOrderId,
        status: result.status,
        dryRun: false
      }
    };
  } catch (error) {
    const message = (error as Error).message;
    await repo.markCancelled(order.id, message);
    throw error;
  }
}

app.get('/health', async () => ({ ok: true, twsConnected: tws.isConnected() }));

app.post('/execution/bootstrap', async () => {
  const { accountId, accounts } = await ensureBrokerSession();
  return {
    socket: {
      host: config.IB_SOCKET_HOST,
      port: config.IB_SOCKET_PORT,
      clientId: config.EXECUTION_CLIENT_ID
    },
    accountId,
    accounts
  };
});

app.get('/execution/account/summary', async (request) => {
  const query = z
    .object({
      force: z.coerce.boolean().default(false)
    })
    .parse(request.query ?? {});

  const { accountId, accounts } = await ensureBrokerSession();

  if (!query.force && accountSnapshotCache && accountSnapshotCache.accountId === accountId && Date.now() - accountSnapshotCache.fetchedAtMs < 10_000) {
    return {
      source: 'cache',
      accounts,
      ...accountSnapshotCache.snapshot
    };
  }

  const snapshot = await tws.getAccountSnapshot(accountId);
  accountSnapshotCache = {
    accountId,
    fetchedAtMs: Date.now(),
    snapshot
  };

  return {
    source: 'live',
    accounts,
    ...snapshot
  };
});

app.get('/execution/orders', async (request) => {
  const query = z
    .object({
      limit: z.coerce.number().int().min(1).max(500).default(50),
      instrument: z.string().trim().optional(),
      side: z.enum(['BUY', 'SELL', 'HOLD']).optional(),
      type: z.enum(['MKT', 'LMT']).optional(),
      qty: z.string().trim().optional(),
      status: z.enum(['PROPOSED', 'REJECTED', 'SUBMITTED', 'FILLED', 'CANCELLED']).optional(),
      risk: z.enum(['PASS', 'REJECT']).optional()
    })
    .parse(request.query ?? {});

  let qty: number | undefined;
  if (query.qty) {
    const parsed = Number(query.qty);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid qty filter: ${query.qty}`);
    }
    qty = parsed;
  }

  const filters: OrderListFilters = {
    instrument: query.instrument || undefined,
    side: query.side,
    orderType: query.type,
    qty,
    status: query.status as ProposedOrderStatus | undefined,
    riskCheckStatus: query.risk
  };

  return repo.listOrders(query.limit, filters);
});

app.post('/execution/execute-proposed/:id', async (request, reply) => {
  const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params ?? {});
  const body = z.object({ dryRun: z.boolean().optional() }).parse(request.body ?? {});

  const order = await repo.getProposedOrderById(params.id);
  if (!order) {
    return reply.code(404).send({ error: `proposed order id=${params.id} not found` });
  }

  if (order.status !== 'PROPOSED') {
    return reply.code(409).send({ error: `order id=${params.id} is not PROPOSED (current=${order.status})` });
  }

  try {
    const result = await executePersistedOrder(order, body.dryRun ?? config.executionDryRun);
    return {
      order,
      ...result
    };
  } catch (error) {
    return reply.code(400).send({ error: (error as Error).message });
  }
});

app.post('/execution/execute-ticket', async (request, reply) => {
  const body = executeTicketBodySchema.parse(request.body ?? {});
  const ticket = body.ticket as SignalTicket;

  if (!body.persist) {
    const validationError = validateExecutableTicket(ticket);
    if (validationError) {
      return reply.code(400).send({ error: validationError });
    }

    try {
      const { accountId } = await ensureBrokerSession();

      if (body.dryRun ?? config.executionDryRun) {
        return {
          execution: {
            accountId,
            status: 'DRYRUN',
            dryRun: true
          }
        };
      }

      const result = await tws.placeSignalOrder(ticket, accountId, config.EXECUTION_DEFAULT_TIF);
      return {
        execution: {
          accountId,
          brokerOrderId: result.brokerOrderId,
          status: result.status,
          dryRun: false
        }
      };
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  }

  const insertedId = await repo.insertProposedFromTicket(ticket, body.strategy);
  const inserted = await repo.getProposedOrderById(insertedId);
  if (!inserted) {
    return reply.code(500).send({ error: 'failed to read inserted proposed order' });
  }

  try {
    const result = await executePersistedOrder(inserted, body.dryRun ?? config.executionDryRun);
    const fresh = await repo.getProposedOrderById(insertedId);

    return {
      order: fresh,
      ...result
    };
  } catch (error) {
    const fresh = await repo.getProposedOrderById(insertedId);
    return reply.code(400).send({ error: (error as Error).message, order: fresh });
  }
});

async function main(): Promise<void> {
  await repo.init();
  const address = await app.listen({ port: config.EXECUTION_PORT, host: '0.0.0.0' });
  app.log.info(`execution-engine listening on ${address}`);
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    try {
      tws.disconnect();
      await app.close();
      await pool.end();
    } finally {
      process.exit(0);
    }
  });
}
