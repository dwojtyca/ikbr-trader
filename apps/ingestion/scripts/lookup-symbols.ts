/* eslint-disable */
// One-off contract lookup against a running IB Gateway.
// Run: pnpm --filter @ikbr/ingestion exec tsx scripts/lookup-symbols.ts
import IB from "ib";

type Attempt = {
  symbol: string;
  secType: string;
  exchange: string;
  primaryExchange?: string;
  currency: string;
};

const HOST = process.env.IB_SOCKET_HOST ?? "127.0.0.1";
const PORT = Number(process.env.IB_SOCKET_PORT ?? 4002);
const CLIENT_ID = 909101;

// (symbol, list of contract spec attempts in order)
const CANDIDATES: Array<{ label: string; attempts: Attempt[] }> = [
  // US equities — SMART/USD
  ...[
    "NFLX",
    "UBER",
    "DIS",
    "BA",
    "LLY",
    "MARA",
    "RIOT",
    "BABA",
    "JPM",
    "GS",
    "HOOD",
    "XOM",
    "CVX",
  ].map((s) => ({
    label: s,
    attempts: [
      {
        symbol: s,
        secType: "STK",
        exchange: "SMART",
        primaryExchange: "NASDAQ",
        currency: "USD",
      },
      {
        symbol: s,
        secType: "STK",
        exchange: "SMART",
        primaryExchange: "NYSE",
        currency: "USD",
      },
      { symbol: s, secType: "STK", exchange: "SMART", currency: "USD" },
    ],
  })),

  // US sector ETFs (NYSE Arca) — SMART/USD
  ...["XLE", "XLF", "XLK", "XLV", "DIA", "GLD", "SLV"].map((s) => ({
    label: s,
    attempts: [
      {
        symbol: s,
        secType: "STK",
        exchange: "SMART",
        primaryExchange: "ARCA",
        currency: "USD",
      },
      { symbol: s, secType: "STK", exchange: "SMART", currency: "USD" },
    ],
  })),

  // WSE (Warsaw) PLN
  ...[
    "PKN",
    "PKO",
    "SPL",
    "CDR",
    "JSW",
    "CCC",
    "MBK",
    "TPE",
    "PGE",
    "CPS",
    "KRU",
    "BDX",
    "11B",
    "KTY",
  ].map((s) => ({
    label: s,
    attempts: [
      {
        symbol: s,
        secType: "STK",
        exchange: "WSE",
        primaryExchange: "WSE",
        currency: "PLN",
      },
    ],
  })),
];

interface Detail {
  conId?: number;
  symbol?: string;
  secType?: string;
  exchange?: string;
  primaryExch?: string;
  currency?: string;
  longName?: string;
}

function newClient(): any {
  // @ts-ignore - ib package types are loose
  return new IB({ host: HOST, port: PORT, clientId: CLIENT_ID });
}

const ib: any = newClient();

let reqSeq = 1000;
type Resolver = (details: Detail[]) => void;
type Rejecter = (err: Error) => void;
const pending = new Map<
  number,
  {
    resolve: Resolver;
    reject: Rejecter;
    buf: Detail[];
    timer: NodeJS.Timeout;
    label: string;
  }
>();

ib.on("error", (err: any, code?: number, reqId?: number) => {
  if (typeof reqId === "number" && pending.has(reqId)) {
    const p = pending.get(reqId)!;
    if (p.buf.length === 0) {
      clearTimeout(p.timer);
      pending.delete(reqId);
      p.reject(new Error(`IB error ${code ?? "?"}: ${err?.message ?? err}`));
    }
  } else if (
    code &&
    code !== 2104 &&
    code !== 2106 &&
    code !== 2158 &&
    code !== 2107 &&
    code !== 2100
  ) {
    // ignore connectivity notices
    // console.error("IB:", code, err?.message ?? err);
  }
});

ib.on("contractDetails", (reqId: number, contract: any) => {
  const p = pending.get(reqId);
  if (!p) return;
  const c = contract?.summary ?? contract?.contract ?? contract;
  p.buf.push({
    conId: c.conId ?? c.conid,
    symbol: c.symbol,
    secType: c.secType,
    exchange: c.exchange,
    primaryExch: c.primaryExch ?? c.primaryExchange,
    currency: c.currency,
    longName: contract?.longName,
  });
});

ib.on("contractDetailsEnd", (reqId: number) => {
  const p = pending.get(reqId);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(reqId);
  p.resolve(p.buf);
});

async function lookup(label: string, attempt: Attempt): Promise<Detail[]> {
  const reqId = reqSeq++;
  return new Promise<Detail[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error("timeout"));
    }, 8000);
    pending.set(reqId, { resolve, reject, buf: [], timer, label });
    try {
      ib.reqContractDetails(reqId, attempt);
    } catch (e: any) {
      clearTimeout(timer);
      pending.delete(reqId);
      reject(e);
    }
  });
}

async function run() {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("connect timeout")), 8000);
    ib.once("connected", () => {
      clearTimeout(t);
      resolve();
    });
    ib.on("server", () => {}); // noop
    ib.connect();
    setTimeout(() => {
      clearTimeout(t);
      resolve();
    }, 1500); // ib package fires connect synchronously sometimes
  });

  console.log("symbol\tconid\tsecType\texchange\tprimary\tcurrency\tlongName");
  for (const c of CANDIDATES) {
    let resolved: Detail | undefined;
    let attemptUsed = "";
    let lastErr = "";
    for (const a of c.attempts) {
      try {
        const details = await lookup(c.label, a);
        if (details.length > 0) {
          // prefer one matching attempt currency
          resolved =
            details.find((d) => d.currency === a.currency) ?? details[0];
          attemptUsed = `${a.secType}/${a.exchange}${a.primaryExchange ? "@" + a.primaryExchange : ""}/${a.currency}`;
          break;
        }
      } catch (e: any) {
        lastErr = e?.message ?? String(e);
      }
    }
    if (resolved) {
      console.log(
        [
          c.label,
          resolved.conId ?? "-",
          resolved.secType ?? "-",
          resolved.exchange ?? "-",
          resolved.primaryExch ?? "-",
          resolved.currency ?? "-",
          resolved.longName ?? "-",
          `(${attemptUsed})`,
        ].join("\t"),
      );
    } else {
      console.log(
        `${c.label}\tNOT_FOUND\t-\t-\t-\t-\t${lastErr || "no match"}`,
      );
    }
  }
  try {
    ib.disconnect();
  } catch {}
  setTimeout(() => process.exit(0), 250);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
