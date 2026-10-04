import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { researchFixture } from '@ikbr/shared/instrument-research-testfixture';
import { parseDiagnosticReport } from '@ikbr/shared/diagnostics';
import { registerDiagnosticRoutes } from './routes.js';
import { createDiagnosticReadModel } from './read-model.js';

// Run only inside the isolated verification container, without published ports.
async function main(): Promise<void> {
  const target = process.env.TEST_POSTGRES_URL;
  if (!target || !/^\/pp6_restore_[a-z0-9_]+$/.test(new URL(target).pathname) || process.env.PP6_ISOLATED_DRILL !== 'true') {
    throw Error('ISOLATED_PP6_OPERATOR_DRILL_REQUIRED');
  }
  const account = 'DU_PP6_SYNTHETIC', token = 'pp6-fixture-only-not-a-real-token';
  const pool = new Pool({ connectionString: target });
  const config = researchFixture().config;
  const model = createDiagnosticReadModel({
    pool, currentAccountId: () => account, currentSessionId: () => 'restarted-process',
    configuration: () => ({ configHash: null, instruments: config.instruments.filter(item => item.entryEnabled).map(item => ({
      id: item.id, symbol: item.contract.symbol, listing: item.contract.exchange, conId: String(item.contract.conId),
      implementationId: null, instanceId: null, revision: null,
    })) }),
    runtimeControls: () => ({ tradingEnabled: false, entriesPaused: true, automationEnabled: false }),
  });
  const app = Fastify();
  let reads = 0;
  app.addHook('onRequest', async request => { assert.equal(request.method, 'GET'); reads++; });
  registerDiagnosticRoutes(app, { token, read: model.read, privacy: () => ({ accountIds: [account], secrets: [token] }) });
  const workspace = fileURLToPath(new URL('../../../../', import.meta.url));
  const directory = await mkdtemp(join(workspace, '.pp6-operator-'));
  const environmentFile = join(directory, 'fixture.env');
  await writeFile(environmentFile, `EXECUTION_API_TOKEN=${token}\nPAPER_OPS_BASE_URL=http://127.0.0.1:3103\n`, { mode: 0o600 });
  const childEnvironment = { ...process.env };
  delete childEnvironment.EXECUTION_API_TOKEN;
  delete childEnvironment.PAPER_OPS_BASE_URL;
  delete childEnvironment.INIT_CWD;
  const execute = promisify(execFile);
  try {
    await app.listen({ host: '127.0.0.1', port: 3103 });
    const now = Date.now(), from = new Date(now - 3600000).toISOString(), to = new Date(now).toISOString();
    const run = async (args: string[]) => execute('pnpm', ['paper:ops', '--env-file', relative(workspace, environmentFile), ...args], {
      cwd: workspace, env: childEnvironment,
      timeout: 15000, maxBuffer: 3 * 1024 * 1024,
    });
    for (const instrument of ['pko_wse', 'aapl_smart', 'xyz_nyse']) {
      const result = await run(['status', '--instrument', instrument]);
      assert.match(result.stdout, /Raport diagnostyczny/);
      assert.ok(result.stdout.includes(instrument));
      assert.doesNotMatch(result.stdout, /DU_PP6_SYNTHETIC|pp6-fixture-only-not-a-real-token/);
    }
    assert.match((await run(['logs'])).stdout, /Zdarzenia/);
    assert.match((await run(['trace', '--proposal', '42'])).stdout, /SUBMISSION_UNKNOWN|UNKNOWN/);
    assert.match((await run(['session', '--from', from, '--to', to])).stdout, /Liczniki/);
    const output = join(directory, 'diagnostics.json');
    await run(['export', '--from', from, '--to', to, '--output', relative(workspace, output), '--json']);
    const contents = await readFile(output, 'utf8');
    const report = parseDiagnosticReport(JSON.parse(contents));
    assert.ok(report.omissions.includes('EXPORT_REDACTED_IDENTIFIERS_FINANCIAL_UNTRUSTED_AUDIT_LINKS'));
    assert.doesNotMatch(contents, /DU_PP6_SYNTHETIC|pp6-fixture-only-not-a-real-token/);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal(reads, 7);
    process.stdout.write('PASS: pnpm paper:ops ze względnym env/export; status (3 instrumenty), logs, trace, session i export bez UI; wyłącznie 7 odczytów HTTP.\n');
  } finally {
    await app.close();
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write('Próba terminalowa PP6 NIEUDANA.\n'); process.exitCode = 1; });
}
