import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const COMPONENTS = [
  "preflight", "no_order_full", "exact_evaluator", "high_write_full",
  "identity_reload", "artifact", "composed",
] as const;
const ITERATIONS = ["warmup", "measured-1", "measured-2", "measured-3"] as const;
const SOURCE_DATABASE = "ikbr_trader_backtest_pr15_5a";
const TEMPLATE_DATABASE = "pr15d2_template";
const BENCHMARK_POSTGRES = "pr155d2-postgres";
const BENCHMARK_POSTGRES_VOLUME = "pr155d2-pgdata";
const IMAGE = "ikbr-trader-app:local";
const MEMORY_LIMIT = 4_294_967_296;
const TABLE_COUNTS_SQL = `select json_build_object(
  'backtest_runs',(select count(*) from backtest_runs),
  'backtest_orders',(select count(*) from backtest_orders),
  'backtest_fills',(select count(*) from backtest_fills),
  'backtest_strategy_state',(select count(*) from backtest_strategy_state),
  'backtest_signal_diagnostics',(select count(*) from backtest_signal_diagnostics),
  'backtest_research_experiments',(select count(*) from backtest_research_experiments)
)::text;`;
const DATASET_FINGERPRINT_SQL = "select fingerprint from backtest_datasets;";
const POSTGRES_SETTINGS_SQL = `select json_build_object(
  'server_version',current_setting('server_version'),
  'autovacuum',current_setting('autovacuum'),
  'shared_buffers',current_setting('shared_buffers'),
  'work_mem',current_setting('work_mem'),
  'maintenance_work_mem',current_setting('maintenance_work_mem'),
  'effective_cache_size',current_setting('effective_cache_size'),
  'random_page_cost',current_setting('random_page_cost'),
  'effective_io_concurrency',current_setting('effective_io_concurrency'),
  'wal_sync_method',current_setting('wal_sync_method'),
  'checkpoint_timeout',current_setting('checkpoint_timeout'),
  'max_wal_size',current_setting('max_wal_size'),
  'synchronous_commit',current_setting('synchronous_commit')
)::text;`;

type CommandResult = { stdout: string; stderr: string; wallMs: number; exitCode: number };
type BenchmarkResult = {
  component: string;
  iteration: string;
  wallMs: number;
  peakRssBytes: number;
  implementationCommitSha: string;
  imageDigest: string;
  nodeVersion: string;
  nodeHeapLimitBytes: number;
  containerMemoryLimit: string;
  containerCpuLimit: string;
  containerMemoryPeakBytes: string;
  containerSwapCurrentBytes: string;
  containerSwapPeakBytes: string;
  containerMemoryEvents: string;
  containerMemoryPressure: string;
};
type EvidenceRecord = {
  ordinal: number;
  component: string;
  iteration: string;
  containerWallMs: number;
  benchmark: BenchmarkResult;
  imageInspection: { image: string; oomKilled: boolean; exitCode: number };
  sourceRowCounts: Record<string, number>;
  startingRowCounts: Record<string, number>;
  endingRowCounts: Record<string, number>;
  completedBenchmarkRuns: number;
  highWriteAssertions: { runs: number; filledOrders: number; wideOrders: number; wideFills: number };
  hostSwapBefore: string;
  hostSwapAfter: string;
  hostPowerBefore: string;
  hostPowerAfter: string;
};

function run(command: string, args: string[], stream = false): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(command, args, { cwd: process.cwd(), env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stream) process.stderr.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stream) process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({
      stdout: stdout.trim(), stderr: stderr.trim(),
      wallMs: performance.now() - started, exitCode: code ?? -1,
    }));
  });
}

async function checked(command: string, args: string[], stream = false): Promise<CommandResult> {
  const result = await run(command, args, stream);
  if (result.exitCode !== 0)
    throw new Error(`${command} ${args.join(" ")} failed (${result.exitCode}): ${result.stderr || result.stdout}`);
  return result;
}

function runBuffer(command: string, args: string[]): Promise<{ stdout: Buffer; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env: process.env });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout: Buffer.concat(chunks), stderr: stderr.trim(), exitCode: code ?? -1 }));
  });
}

function runWithInput(command: string, args: string[], input: Buffer): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(command, args, { cwd: process.cwd(), env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), wallMs: performance.now() - started, exitCode: code ?? -1 }));
    child.stdin.end(input);
  });
}

const docker = (...args: string[]) => checked("/usr/local/bin/docker", args);
const compose = (...args: string[]) => docker("compose", ...args);
const psql = (database: string, sql: string) => compose(
  "exec", "-T", "postgres", "psql", "-U", "postgres", "-d", database, "-Atc", sql,
);
const benchmarkExec = (...args: string[]) => docker("exec", BENCHMARK_POSTGRES, ...args);
const benchmarkPsql = (database: string, sql: string) => benchmarkExec(
  "psql", "-U", "postgres", "-d", database, "-Atc", sql,
);

function parseJson<T>(value: string, label: string): T {
  try { return JSON.parse(value) as T; }
  catch { throw new Error(`${label} was not a single valid JSON value: ${value.slice(0, 500)}`); }
}

function parseSwapUsedMb(value: string): number {
  const match = value.match(/used\s*=\s*([0-9.]+)M/);
  if (!match) throw new Error(`Cannot parse host swap evidence: ${value}`);
  return Number(match[1]);
}

function parseKeyValues(value: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const line of value.split("\n")) {
    const [key, raw] = line.trim().split(/\s+/);
    if (!key || raw === undefined || !Number.isFinite(Number(raw)))
      throw new Error(`Cannot parse cgroup key/value evidence: ${value}`);
    result[key] = Number(raw);
  }
  return result;
}

function pressureTotals(value: string): number[] {
  const matches = [...value.matchAll(/total=(\d+)/g)].map((match) => Number(match[1]));
  if (matches.length !== 2) throw new Error(`Cannot parse cgroup memory pressure: ${value}`);
  return matches;
}

function equalCounts(left: Record<string, number>, right: Record<string, number>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function median(values: number[]): number {
  return [...values].sort((left, right) => left - right)[1];
}

function sampleSd(values: number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

function upperBound(values: number[]): number {
  const middle = median(values);
  return (middle + Math.max(0.5 * middle, 2 * sampleSd(values))) * 1.20;
}

async function hostEvidence(): Promise<{ swap: string; power: string }> {
  const [swap, power] = await Promise.all([
    checked("/usr/sbin/sysctl", ["-n", "vm.swapusage"]),
    checked("/usr/bin/pmset", ["-g", "batt"]),
  ]);
  if (!power.stdout.includes("AC Power")) throw new Error(`Benchmark requires AC power: ${power.stdout}`);
  parseSwapUsedMb(swap.stdout);
  return { swap: swap.stdout, power: power.stdout };
}

async function resetDatabase(sourceCounts: Record<string, number>): Promise<Record<string, number>> {
  await benchmarkExec("dropdb", "-U", "postgres", "--if-exists", SOURCE_DATABASE);
  await benchmarkExec("createdb", "-U", "postgres", "-T", TEMPLATE_DATABASE, SOURCE_DATABASE);
  const counts = parseJson<Record<string, number>>((await benchmarkPsql(SOURCE_DATABASE, TABLE_COUNTS_SQL)).stdout, "starting row counts");
  if (!equalCounts(counts, sourceCounts)) throw new Error("Fresh benchmark clone row counts differ from source snapshot");
  return counts;
}

function delta(record: EvidenceRecord, table: string): number {
  return record.endingRowCounts[table] - record.startingRowCounts[table];
}

function validateEndingRows(record: EvidenceRecord): void {
  const zero = ["backtest_runs", "backtest_orders", "backtest_fills", "backtest_strategy_state",
    "backtest_signal_diagnostics", "backtest_research_experiments"];
  if (["preflight", "identity_reload", "exact_evaluator"].includes(record.component)) {
    for (const table of zero) if (delta(record, table) !== 0) throw new Error(`${record.component} unexpectedly changed ${table}`);
    if (record.completedBenchmarkRuns !== 0) throw new Error(`${record.component} unexpectedly completed a benchmark run`);
    return;
  }
  const expected: Record<string, number> = record.component === "artifact"
    ? { backtest_runs: 0, backtest_orders: 0, backtest_fills: 0, backtest_strategy_state: 0,
      backtest_signal_diagnostics: 0, backtest_research_experiments: 1 }
    : record.component === "high_write_full"
      ? { backtest_runs: 1, backtest_orders: 423_300, backtest_fills: 423_300, backtest_strategy_state: 1,
        backtest_signal_diagnostics: 1_269_900, backtest_research_experiments: 0 }
      : record.component === "composed"
        ? { backtest_runs: 2, backtest_orders: 423_300, backtest_fills: 423_300, backtest_strategy_state: 2,
          backtest_research_experiments: 0 }
        : { backtest_runs: 1, backtest_orders: 0, backtest_fills: 0, backtest_strategy_state: 1,
          backtest_research_experiments: 0 };
  for (const [table, count] of Object.entries(expected))
    if (delta(record, table) !== count) throw new Error(`${record.component} ${table} delta ${delta(record, table)} != ${count}`);
  const expectedCompletedRuns = record.component === "composed" ? 2
    : record.component === "no_order_full" || record.component === "high_write_full" ? 1 : 0;
  if (record.completedBenchmarkRuns !== expectedCompletedRuns)
    throw new Error(`${record.component} completed runs ${record.completedBenchmarkRuns} != ${expectedCompletedRuns}`);
  const diagnostics = delta(record, "backtest_signal_diagnostics");
  if (record.component === "no_order_full" && (diagnostics <= 0 || diagnostics > 1_269_900))
    throw new Error(`no_order_full diagnostic delta is invalid: ${diagnostics}`);
  if (record.component === "composed" && (diagnostics <= 1_269_900 || diagnostics > 2_539_800))
    throw new Error(`composed diagnostic delta is invalid: ${diagnostics}`);
  const expectedHighWrite = record.component === "high_write_full" || record.component === "composed" ? 423_300 : 0;
  const expectedHighWriteRuns = expectedHighWrite > 0 ? 1 : 0;
  if (record.highWriteAssertions.runs !== expectedHighWriteRuns ||
    record.highWriteAssertions.filledOrders !== expectedHighWrite ||
    record.highWriteAssertions.wideOrders !== expectedHighWrite ||
    record.highWriteAssertions.wideFills !== expectedHighWrite)
    throw new Error(`${record.component} high-write terminal assertions failed: ${JSON.stringify(record.highWriteAssertions)}`);
}

function validateRecord(record: EvidenceRecord, sha: string, imageDigest: string): void {
  const result = record.benchmark;
  if (result.component !== record.component || result.iteration !== record.iteration)
    throw new Error("Benchmark identity differs from matrix cell");
  if (result.implementationCommitSha !== sha || result.imageDigest !== imageDigest)
    throw new Error("Benchmark SHA/image identity mismatch");
  if (record.imageInspection.image !== imageDigest || record.imageInspection.exitCode !== 0 || record.imageInspection.oomKilled)
    throw new Error("Container image/exit/OOM inspection failed");
  for (const value of [result.containerMemoryPeakBytes, result.containerSwapCurrentBytes,
    result.containerSwapPeakBytes, result.containerMemoryEvents, result.containerMemoryPressure,
    result.containerMemoryLimit, result.containerCpuLimit])
    if (!value || value === "unavailable") throw new Error("Required cgroup evidence is unavailable");
  if (!result.nodeVersion || !Number.isFinite(result.nodeHeapLimitBytes))
    throw new Error("Required Node runtime evidence is unavailable");
  if (Number(result.containerMemoryPeakBytes) > MEMORY_LIMIT || result.peakRssBytes > MEMORY_LIMIT)
    throw new Error("4 GiB memory gate exceeded");
  if (Number(result.containerSwapCurrentBytes) !== 0 || Number(result.containerSwapPeakBytes) !== 0)
    throw new Error("Container swap gate exceeded");
  const events = parseKeyValues(result.containerMemoryEvents);
  for (const [key, value] of Object.entries(events))
    if (value !== 0) throw new Error(`Container memory event gate exceeded: ${key}`);
  if (pressureTotals(result.containerMemoryPressure).some((value) => value !== 0))
    throw new Error("Container memory-pressure gate exceeded");
  if (!record.hostPowerBefore.includes("AC Power") || !record.hostPowerAfter.includes("AC Power"))
    throw new Error("Host power changed away from AC");
  if (parseSwapUsedMb(record.hostSwapAfter) > parseSwapUsedMb(record.hostSwapBefore))
    throw new Error("Host swap usage increased during invocation");
  if (!equalCounts(record.startingRowCounts, record.sourceRowCounts))
    throw new Error("Invocation did not start from the source snapshot");
  validateEndingRows(record);
}

const evidenceDirectory = process.env.BENCHMARK_EVIDENCE_DIR;
if (!evidenceDirectory) throw new Error("BENCHMARK_EVIDENCE_DIR is required");
const status = await checked("git", ["status", "--porcelain"]);
if (status.stdout) throw new Error("Benchmark suite requires a clean Git worktree");
const sha = (await checked("git", ["rev-parse", "HEAD"])).stdout;
if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error(`Invalid HEAD SHA: ${sha}`);

const build = await run("/usr/local/bin/docker", ["compose", "build", "backtest-engine"], true);
if (build.exitCode !== 0) throw new Error(`Production image build failed: ${build.stderr}`);
const imageDigest = (await docker("image", "inspect", IMAGE, "--format", "{{.Id}}")).stdout;
if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest)) throw new Error(`Invalid image ID: ${imageDigest}`);
await mkdir(evidenceDirectory, { recursive: false });
await writeFile(path.join(evidenceDirectory, "image-build.log"), `${build.stdout}\n${build.stderr}\n`);

const sourceActiveConnections = Number((await psql("postgres",
  `select count(*) from pg_stat_activity where datname='${SOURCE_DATABASE}';`,
)).stdout);
if (sourceActiveConnections !== 0) throw new Error(`Source database has ${sourceActiveConnections} active connections`);
const sourceCounts = parseJson<Record<string, number>>((await psql(SOURCE_DATABASE, TABLE_COUNTS_SQL)).stdout, "source row counts");
const sourceFingerprint = (await psql(SOURCE_DATABASE, DATASET_FINGERPRINT_SQL)).stdout;
if (!/^[a-f0-9]{64}$/.test(sourceFingerprint)) throw new Error(`Invalid source fingerprint: ${sourceFingerprint}`);
const dump = await runBuffer("/usr/local/bin/docker", [
  "compose", "exec", "-T", "postgres", "pg_dump", "-U", "postgres", "-Fc", SOURCE_DATABASE,
]);
if (dump.exitCode !== 0) throw new Error(`Source snapshot dump failed: ${dump.stderr}`);
const sourcePostgresContainer = (await compose("ps", "-q", "postgres")).stdout;
const sourceInspection = parseJson<Array<{
  Image: string;
  NetworkSettings: { Networks: Record<string, unknown> };
  Mounts: Array<{ Type: string; Name?: string; Destination: string }>;
}>>((await docker("inspect", sourcePostgresContainer)).stdout, "source PostgreSQL inspection")[0];
const sourceNetworks = sourceInspection.NetworkSettings.Networks;
const networkNames = Object.keys(sourceNetworks);
if (networkNames.length !== 1) throw new Error(`Expected one Compose network; received ${networkNames.join(",")}`);
const sourceDataMount = sourceInspection.Mounts.find((mount) => mount.Destination === "/var/lib/postgresql/data");
if (!sourceDataMount || sourceDataMount.Type !== "volume" || !sourceDataMount.Name)
  throw new Error("Source PostgreSQL does not use the expected named pgdata volume");
const sourceVolumeDriver = parseJson<Array<{ Driver: string }>>((await docker(
  "volume", "inspect", sourceDataMount.Name,
)).stdout, "source PostgreSQL volume inspection")[0].Driver;
const sourcePostgresSettings = parseJson<Record<string, string>>(
  (await psql(SOURCE_DATABASE, POSTGRES_SETTINGS_SQL)).stdout, "source PostgreSQL settings",
);
const privateSetup = await (async () => {
  try {
    await docker("rm", "-f", BENCHMARK_POSTGRES).catch(() => undefined);
    await docker("volume", "rm", "-f", BENCHMARK_POSTGRES_VOLUME).catch(() => undefined);
    await docker("volume", "create", "--driver", sourceVolumeDriver, BENCHMARK_POSTGRES_VOLUME);
    await docker("run", "-d", "--name", BENCHMARK_POSTGRES, "--network", networkNames[0],
      "--mount", `type=volume,source=${BENCHMARK_POSTGRES_VOLUME},target=/var/lib/postgresql/data`,
      "-e", "POSTGRES_PASSWORD=postgres", sourceInspection.Image);
    const privateInspection = parseJson<Array<{
      Image: string; Mounts: Array<{ Type: string; Name?: string; Destination: string }>;
    }>>((await docker("inspect", BENCHMARK_POSTGRES)).stdout, "private PostgreSQL inspection")[0];
    if (privateInspection.Image !== sourceInspection.Image)
      throw new Error(`PostgreSQL image mismatch: ${privateInspection.Image} != ${sourceInspection.Image}`);
    const privateDataMount = privateInspection.Mounts.find((mount) => mount.Destination === "/var/lib/postgresql/data");
    if (!privateDataMount || privateDataMount.Type !== "volume" || privateDataMount.Name !== BENCHMARK_POSTGRES_VOLUME)
      throw new Error("Private PostgreSQL does not use the dedicated named pgdata volume");
    let postgresReady = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const ready = await run("/usr/local/bin/docker", ["exec", BENCHMARK_POSTGRES, "pg_isready", "-U", "postgres"]);
      if (ready.exitCode === 0) { postgresReady = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!postgresReady) throw new Error("Dedicated benchmark PostgreSQL did not become ready");
    await benchmarkExec("createdb", "-U", "postgres", TEMPLATE_DATABASE);
    const restore = await runWithInput("/usr/local/bin/docker", [
      "exec", "-i", BENCHMARK_POSTGRES, "pg_restore", "-U", "postgres", "-d", TEMPLATE_DATABASE,
      "--no-owner", "--no-privileges",
    ], dump.stdout);
    if (restore.exitCode !== 0) throw new Error(`Private template restore failed: ${restore.stderr}`);
    await benchmarkPsql(TEMPLATE_DATABASE, "ANALYZE;");
    const postgresSettings = parseJson<Record<string, string>>(
      (await benchmarkPsql(TEMPLATE_DATABASE, POSTGRES_SETTINGS_SQL)).stdout, "private PostgreSQL settings",
    );
    if (JSON.stringify(postgresSettings) !== JSON.stringify(sourcePostgresSettings))
      throw new Error("Private PostgreSQL runtime settings differ from Stage B research database");
    const templateCounts = parseJson<Record<string, number>>(
      (await benchmarkPsql(TEMPLATE_DATABASE, TABLE_COUNTS_SQL)).stdout, "template row counts",
    );
    const templateFingerprint = (await benchmarkPsql(TEMPLATE_DATABASE, DATASET_FINGERPRINT_SQL)).stdout;
    if (!equalCounts(templateCounts, sourceCounts) || templateFingerprint !== sourceFingerprint)
      throw new Error("Private PostgreSQL template differs from immutable source evidence");
    await writeFile(path.join(evidenceDirectory, "suite-metadata.json"), `${JSON.stringify({
      sha, imageDigest, sourceDatabase: SOURCE_DATABASE, sourceFingerprint,
      privateTemplateDatabase: TEMPLATE_DATABASE, privatePostgresContainer: BENCHMARK_POSTGRES,
      sourceCounts, templateCounts, sourceActiveConnections,
      sourcePostgresImageId: sourceInspection.Image, sourcePostgresVolumeDriver: sourceVolumeDriver,
      privatePostgresImageId: privateInspection.Image,
      privatePostgresVolume: BENCHMARK_POSTGRES_VOLUME,
      sourcePostgresSettings, privatePostgresSettings: postgresSettings,
    }, null, 2)}\n`);
    return { privateInspection, postgresSettings, templateCounts, templateFingerprint };
  } catch (error) {
    const cleanup: string[] = [];
    try { await docker("rm", "-f", BENCHMARK_POSTGRES); }
    catch (cleanupError) { cleanup.push(`container: ${(cleanupError as Error).message}`); }
    try { await docker("volume", "rm", "-f", BENCHMARK_POSTGRES_VOLUME); }
    catch (cleanupError) { cleanup.push(`volume: ${(cleanupError as Error).message}`); }
    throw new Error(`Private PostgreSQL setup failed: ${(error as Error).message}${cleanup.length ? `; cleanup: ${cleanup.join("; ")}` : ""}`);
  }
})();

const rawPath = path.join(evidenceDirectory, "raw.jsonl");
const records: EvidenceRecord[] = [];
let ordinal = 0;
let currentContainer: string | undefined;
const cleanupErrors: string[] = [];
try {
  for (const component of COMPONENTS) {
    for (const iteration of ITERATIONS) {
      ordinal += 1;
      process.stderr.write(`[${ordinal}/${COMPONENTS.length * ITERATIONS.length}] ${component}/${iteration}\n`);
      const startingRowCounts = await resetDatabase(sourceCounts);
      const before = await hostEvidence();
      const containerName = `pr155d2-${ordinal}-${component.replaceAll("_", "-")}`;
      currentContainer = containerName;
      await docker("rm", "-f", containerName).catch(() => undefined);
      const execution = await run("/usr/local/bin/docker", [
        "compose", "run", "--no-deps", "--name", containerName,
        "-e", `BENCHMARK_COMPONENT=${component}`,
        "-e", `BENCHMARK_ITERATION=${iteration}`,
        "-e", `BENCHMARK_IMPLEMENTATION_SHA=${sha}`,
        "-e", `BENCHMARK_IMAGE_DIGEST=${imageDigest}`,
        "-e", `BACKTEST_BENCHMARK_POSTGRES_URL=postgresql://postgres:postgres@${BENCHMARK_POSTGRES}:5432/${SOURCE_DATABASE}`,
        "backtest-engine", "node", "apps/backtest-engine/dist/research-v3-benchmark-cli.js",
      ], true);
      const inspectionRaw = await docker("inspect", containerName, "--format",
        "{{json .State}}|{{.Image}}",
      );
      const separator = inspectionRaw.stdout.lastIndexOf("|");
      const state = parseJson<{ OOMKilled: boolean; ExitCode: number }>(inspectionRaw.stdout.slice(0, separator), "container state");
      const image = inspectionRaw.stdout.slice(separator + 1);
      const after = await hostEvidence();
      const endingRowCounts = parseJson<Record<string, number>>((await benchmarkPsql(SOURCE_DATABASE, TABLE_COUNTS_SQL)).stdout, "ending row counts");
      const completedBenchmarkRuns = Number((await benchmarkPsql(SOURCE_DATABASE,
        `select count(*) from backtest_runs where config_json->>'benchmark'='pr15.5d2' and config_json->>'iteration'='${iteration}' and status='completed';`,
      )).stdout);
      const highWriteAssertions = parseJson<EvidenceRecord["highWriteAssertions"]>((await benchmarkPsql(SOURCE_DATABASE, `
        with selected_runs as (
          select id from backtest_runs
          where config_json->>'benchmark'='pr15.5d2'
            and config_json->>'component'='high_write_full'
            and config_json->>'iteration'='${iteration}'
        )
        select json_build_object(
          'runs',(select count(*) from selected_runs),
          'filledOrders',(select count(*) from backtest_orders o join selected_runs r on r.id=o.run_id
            where o.status='FILLED' and o.reason='benchmark | benchmark_fill'),
          'wideOrders',(select count(*) from backtest_orders o join selected_runs r on r.id=o.run_id
            where o.instrument='ES' and o.conid='637533641' and o.side='BUY'
              and o.position_effect='OPEN_OR_ADD' and o.order_type='MKT' and o.quantity=1
              and o.entry=6000 and o.stop=5990 and o.take_profit=6020
              and o.confidence=1 and o.risk_check_status='PASS' and o.strategy='momentum_breakout_long_v1'
              and o.indicator_snapshot is not null and o.trailing_stop_pct=1
              and o.trailing_stop_activation_r=1 and o.generated_from_candle_ts is not null),
          'wideFills',(select count(*) from backtest_fills f join selected_runs r on r.id=f.run_id
            where f.instrument='ES' and f.conid='637533641' and f.strategy='momentum_breakout_long_v1'
              and f.side='BUY' and f.directional_regime='bull_trend' and f.volatility_regime='normal_volatility'
              and f.quantity=1 and f.entry_price=6000 and f.exit_price=6001
              and f.gross_pnl=50 and f.commission=5 and f.net_pnl=45 and f.pnl_pct=0.015
              and f.exit_reason='benchmark' and f.entry_reference_price=6000 and f.entry_fill_price=6000.25
              and f.exit_reference_price=6001 and f.exit_fill_price=6000.75 and f.multiplier=50
              and f.tick_size=0.25 and f.entry_slippage=0.25 and f.exit_slippage=0.25
              and f.slippage_cost=25 and f.commission_per_contract_side=2.5
              and f.entry_conid='637533641' and f.exit_conid='637533641'
              and f.execution_model_version='pr15.5b-v1' and f.calendar_version='cme-equity-index-2024-2026-v1')
        )::text;
      `)).stdout, "high-write terminal assertions");
      const benchmark = parseJson<BenchmarkResult>(execution.stdout, "benchmark output");
      const record: EvidenceRecord = {
        ordinal, component, iteration, containerWallMs: execution.wallMs, benchmark,
        imageInspection: { image, oomKilled: state.OOMKilled, exitCode: state.ExitCode },
        sourceRowCounts: sourceCounts, startingRowCounts, endingRowCounts, completedBenchmarkRuns,
        highWriteAssertions,
        hostSwapBefore: before.swap, hostSwapAfter: after.swap,
        hostPowerBefore: before.power, hostPowerAfter: after.power,
      };
      validateRecord(record, sha, imageDigest);
      records.push(record);
      await appendFile(rawPath, `${JSON.stringify(record)}\n`);
      await docker("rm", containerName);
      currentContainer = undefined;
    }
  }
} finally {
  if (currentContainer) {
    try { await docker("rm", "-f", currentContainer); }
    catch (error) { cleanupErrors.push(`container ${currentContainer}: ${(error as Error).message}`); }
  }
  try {
    const finalSourceCounts = parseJson<Record<string, number>>((await psql(SOURCE_DATABASE, TABLE_COUNTS_SQL)).stdout, "final source row counts");
    const finalSourceFingerprint = (await psql(SOURCE_DATABASE, DATASET_FINGERPRINT_SQL)).stdout;
    if (!equalCounts(finalSourceCounts, sourceCounts) || finalSourceFingerprint !== sourceFingerprint)
      cleanupErrors.push("immutable source counts or fingerprint changed during suite");
  } catch (error) { cleanupErrors.push(`source final verification: ${(error as Error).message}`); }
  try { await docker("rm", "-f", BENCHMARK_POSTGRES); }
  catch (error) { cleanupErrors.push(`private PostgreSQL cleanup: ${(error as Error).message}`); }
  try { await docker("volume", "rm", "-f", BENCHMARK_POSTGRES_VOLUME); }
  catch (error) { cleanupErrors.push(`private PostgreSQL volume cleanup: ${(error as Error).message}`); }
  if (cleanupErrors.length > 0)
    await writeFile(path.join(evidenceDirectory, "cleanup-errors.json"), `${JSON.stringify(cleanupErrors, null, 2)}\n`);
}

if (cleanupErrors.length > 0) throw new Error(`Benchmark cleanup/source verification failed: ${cleanupErrors.join("; ")}`);

if (records.length !== COMPONENTS.length * ITERATIONS.length)
  throw new Error(`Incomplete benchmark matrix: ${records.length} records`);
const identities = new Set(records.map((record) => `${record.component}/${record.iteration}`));
if (identities.size !== records.length) throw new Error("Duplicate benchmark matrix cell");
const runtimeIdentity = new Set(records.map((record) => JSON.stringify({
  sha: record.benchmark.implementationCommitSha,
  image: record.benchmark.imageDigest,
  node: record.benchmark.nodeVersion,
  heap: record.benchmark.nodeHeapLimitBytes,
  memory: record.benchmark.containerMemoryLimit,
  cpu: record.benchmark.containerCpuLimit,
})));
if (runtimeIdentity.size !== 1) throw new Error("Runtime identity differs across benchmark records");

const measured = (component: string) => records
  .filter((record) => record.component === component && record.iteration.startsWith("measured-"))
  .map((record) => record.benchmark.wallMs);
const bounds = Object.fromEntries(COMPONENTS
  .filter((component) => component !== "composed")
  .map((component) => [component, upperBound(measured(component))]));
const medians = Object.fromEntries(COMPONENTS
  .filter((component) => component !== "composed")
  .map((component) => [component, median(measured(component))]));
const scenarioUpperMs = bounds.no_order_full + bounds.exact_evaluator + bounds.high_write_full;
const totalUpperMs = bounds.preflight + 3 * scenarioUpperMs + 3 * bounds.identity_reload + bounds.artifact;
const scenarioMedianMs = medians.no_order_full + medians.exact_evaluator + medians.high_write_full;
const totalMedianMs = medians.preflight + 3 * scenarioMedianMs + 3 * medians.identity_reload + medians.artifact;
const raw = await readFile(rawPath);
const summary = {
  schemaVersion: "pr15.5d2-benchmark-summary-v1",
  sha, imageDigest, rawLogSha256: createHash("sha256").update(raw).digest("hex"),
  formula: "U=(median+max(0.5*median,2*sampleSD))*1.20; sampleSD denominator n-1",
  measuredWallMs: Object.fromEntries(COMPONENTS.map((component) => [component, measured(component)])),
  upperBoundsMs: bounds, mediansMs: medians,
  expectedRangeMs: { scenario: [scenarioMedianMs, scenarioUpperMs], total: [totalMedianMs, totalUpperMs] },
  gates: {
    scenario: { actualMs: scenarioUpperMs, limitMs: 1_800_000, pass: scenarioUpperMs <= 1_800_000 },
    total: { actualMs: totalUpperMs, limitMs: 7_200_000, pass: totalUpperMs <= 7_200_000 },
    memorySwapOomPressure: { pass: true },
  },
};
await writeFile(path.join(evidenceDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary)}\n`);
if (!summary.gates.scenario.pass || !summary.gates.total.pass) process.exitCode = 1;
