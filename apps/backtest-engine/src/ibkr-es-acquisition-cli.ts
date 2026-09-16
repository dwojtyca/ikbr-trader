import "dotenv/config";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  acquireApprovedIbkrEsDataset,
  buildIbkrEsInventorySpec,
} from "./ibkr-es-acquirer.js";
import {
  acquisitionSpecSha256,
  canonicalAcquisitionSpec,
  parseIbkrEsAcquisitionSpec,
} from "./ibkr-es-acquisition-spec.js";
import { HistoricalClient } from "./historical-client.js";
import { CME_EQUITY_INDEX_2024_2026 } from "./cme-equity-index-calendar.js";
import { importResearchDataset } from "./research-dataset-importer.js";

const REPOSITORY_ROOT = path.resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);
const SPEC_PATH = path.join(
  REPOSITORY_ROOT,
  "docs/implementation/phase2/PR15_5C_1_IBKR_ACQUISITION_SPEC.json",
);
const ACQUISITION_ROOT = path.join(REPOSITORY_ROOT, ".local/ibkr-es-acquisition");
const FINAL_BUNDLE_DIRECTORY = path.join(ACQUISITION_ROOT, "final");

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function safeInt(raw: string | undefined, fallback: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid positive integer CLI/environment value");
  return value;
}

async function exists(target: string): Promise<boolean> {
  try { await access(target); return true; } catch { return false; }
}

async function inventory(): Promise<void> {
  if (await exists(SPEC_PATH)) throw new Error(`Refusing to overwrite existing acquisition specification ${SPEC_PATH}`);
  const client = new HistoricalClient({
    host: process.env.IB_SOCKET_HOST ?? "127.0.0.1",
    port: safeInt(process.env.IB_SOCKET_PORT, 4002),
    clientId: safeInt(process.env.IBKR_ES_ACQUISITION_CLIENT_ID, 91551),
    securityType: "FUT", exchange: "CME", currency: "USD",
    pacingPer10Min: 50, maxConcurrency: 2,
  }, (line) => console.error(`[ibkr-es-inventory] ${line}`));
  try {
    await client.connect();
    const spec = await buildIbkrEsInventorySpec(client);
    const temporary = `${SPEC_PATH}.tmp-${process.pid}`;
    await writeFile(temporary, canonicalAcquisitionSpec(spec), { encoding: "utf8", flag: "wx" });
    await rename(temporary, SPEC_PATH);
    console.log(`Stage A specification: ${SPEC_PATH}`);
    console.log(`Specification SHA-256: ${acquisitionSpecSha256(spec)}`);
    console.log(`Estimated historical requests: ${spec.estimatedHistoricalRequests}`);
  } finally { client.disconnect(); }
}

async function dryRun(): Promise<void> {
  const requestedPath = option("--spec") ? path.resolve(option("--spec")!) : SPEC_PATH;
  const spec = parseIbkrEsAcquisitionSpec(JSON.parse(await readFile(requestedPath, "utf8")));
  console.log(JSON.stringify({
    mode: "dry-run", database: "ikbr_trader_backtest_pr15_5a",
    bundleDirectory: FINAL_BUNDLE_DIRECTORY,
    target: spec.target, contracts: spec.contracts.map((contract) => ({
      conId: contract.conId, localSymbol: contract.localSymbol,
      fetchFrom: contract.fetchFrom, fetchTo: contract.fetchTo,
    })),
    estimatedHistoricalRequests: spec.estimatedHistoricalRequests,
    pacing: spec.pacing, specificationSha256: acquisitionSpecSha256(spec),
  }, null, 2));
}

async function acquire(): Promise<void> {
  if (!process.argv.includes("--execute-approved-spec") ||
      !process.argv.includes("--acknowledge-exclusive-history-window"))
    throw new Error("Stage B requires --execute-approved-spec and --acknowledge-exclusive-history-window");
  if ((process.env.TRADING_ENABLED ?? "false").toLowerCase() !== "false")
    throw new Error("Stage B requires TRADING_ENABLED=false");
  const approvedSha256 = option("--approved-sha256");
  if (!approvedSha256 || !/^[a-f0-9]{64}$/.test(approvedSha256))
    throw new Error("Stage B requires --approved-sha256 <64 lowercase hex chars>");
  const spec = parseIbkrEsAcquisitionSpec(JSON.parse(await readFile(SPEC_PATH, "utf8")));
  const actualSha256 = acquisitionSpecSha256(spec);
  if (actualSha256 !== approvedSha256)
    throw new Error(`Approved specification SHA-256 mismatch: expected ${approvedSha256}, actual ${actualSha256}`);
  console.log(JSON.stringify({
    mode: "acquire", tradingEnabled: false,
    database: "ikbr_trader_backtest_pr15_5a",
    bundleDirectory: FINAL_BUNDLE_DIRECTORY,
    target: spec.target,
    contracts: spec.contracts.map(({ conId, localSymbol, fetchFrom, fetchTo }) =>
      ({ conId, localSymbol, fetchFrom, fetchTo })),
    estimatedHistoricalRequests: spec.estimatedHistoricalRequests,
    pacing: spec.pacing,
    specificationSha256: actualSha256,
  }, null, 2));
  const client = new HistoricalClient({
    host: process.env.IB_SOCKET_HOST ?? "127.0.0.1",
    port: safeInt(process.env.IB_SOCKET_PORT, 4002),
    clientId: safeInt(process.env.IBKR_ES_ACQUISITION_CLIENT_ID, 91551),
    securityType: "FUT", exchange: "CME", currency: "USD",
    pacingPer10Min: spec.pacing.requestsPer10Minutes,
    maxConcurrency: spec.pacing.maxConcurrency,
  }, (line) => console.error(`[ibkr-es-acquire] ${line}`));
  let acquisition;
  try {
    await client.connect();
    acquisition = await acquireApprovedIbkrEsDataset(
      spec,
      approvedSha256,
      client,
      CME_EQUITY_INDEX_2024_2026,
      path.join(ACQUISITION_ROOT, "work"),
      FINAL_BUNDLE_DIRECTORY,
    );
  } finally {
    client.disconnect();
  }
  const targetUrl = process.env.BACKTEST_RESEARCH_POSTGRES_URL ??
    "postgresql://postgres:postgres@localhost:5432/ikbr_trader_backtest_pr15_5a";
  const adminUrl = process.env.BACKTEST_POSTGRES_ADMIN_URL ??
    "postgresql://postgres:postgres@localhost:5432/postgres";
  const imported = await importResearchDataset(
    targetUrl,
    adminUrl,
    acquisition.bundleDirectory,
    new Map([[CME_EQUITY_INDEX_2024_2026.version, CME_EQUITY_INDEX_2024_2026]]),
  );
  console.log(JSON.stringify({ acquisition, imported }, null, 2));
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "dry-run";
  if (command === "inventory") return inventory();
  if (command === "dry-run") return dryRun();
  if (command === "acquire") return acquire();
  throw new Error("Usage: research:ibkr-es <inventory|dry-run|acquire>");
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
