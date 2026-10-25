import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAccountingDockerWatcher, inspectAccountingProducers, inspectAccountingNative, runRecoveryHostCommand, ACCOUNTING_APP_SERVICES,
  type InspectCommand, type AccountingRecoveryNativeLaunch } from './accounting-owner-recovery-host.js';
const exec = promisify(execFile);
test('isolated Docker fake TCP one-shot is pinned by actual identity; stream catches another start-stop', { skip: process.env.OWNER_RECOVERY_DOCKER_TEST !== '1', timeout: 30000 }, async () => {
  const docker = async (...args: string[]) => (await exec('docker', args, { timeout: 10000, maxBuffer: 1024 * 1024 })).stdout;
  const requestId = randomUUID(), name = `accounting-owner-recovery-${requestId}`, intruder = `accounting-fixture-${randomUUID()}`;
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'owner-docker-fixture-'))), script = join(directory, 'fake.js');
  const context: string = JSON.parse(await docker('context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'));
  const imageId = (await docker('image', 'inspect', '--format', '{{.Id}}', process.env.OWNER_RECOVERY_TEST_IMAGE ?? 'node:24-bullseye-slim')).trim();
  const project = `owner-fixture-${randomUUID().slice(0, 8)}`, hash = 'a'.repeat(64), now = new Date().toISOString();
  await writeFile(script, "import('node:net').then(({default:net})=>{const s=net.createServer(c=>c.end('fixture'));s.listen(0,'127.0.0.1',()=>{const c=net.connect(s.address().port,'127.0.0.1');c.on('data',()=>{});c.on('end',()=>process.stdout.write('FAKE_TCP_OK\\n'));});setTimeout(()=>{},20000);});", { mode: 0o600 });
  const options = { project, imageId, dockerHost: context, root: directory, host: 'host.docker.internal', port: 7497 };
  const watcher = startAccountingDockerWatcher(options, () => undefined, name);
  try {
    const containerId = (await docker('run', '-d', '--network', 'none', '--workdir', '/app', '--name', name, '--label', `com.docker.compose.project=${project}`, '--label', 'com.docker.compose.service=execution-engine', '--label', 'com.docker.compose.oneoff=True',
      '--mount', `type=bind,src=${script},dst=/app/apps/execution-engine/dist/accounting/owner-recovery-cli.js,readonly`, '--entrypoint', 'node', imageId, 'apps/execution-engine/dist/accounting/owner-recovery-cli.js')).trim();
    const exception = { containerId, imageId, name, requestId }; watcher.allow(exception); await watcher.flush();
    const rows = new Map(ACCOUNTING_APP_SERVICES.slice(0, 4).map((service, i) => { const id = (i + 1).toString(16).padStart(64, '0'); return [id, { Id: id, Image: imageId, Config: { Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': service, 'com.docker.compose.oneoff': 'False' }, Entrypoint: ['docker-entrypoint.sh'], Cmd: ['pnpm', '--filter', `@ikbr/${service}`, 'start'] }, State: { Status: 'exited', Running: false, Paused: false, Restarting: false, Pid: 0, StartedAt: '2020-01-01T00:00:00Z', FinishedAt: '2020-01-02T00:00:00Z' } }]; }));
    const command = async (_file: string, args: readonly string[]) => {
      if (args[0] === 'context') return JSON.stringify(context);
      if (args[2] === 'info') return JSON.stringify({ OperatingSystem: 'Docker Desktop', OSType: 'linux' });
      if (args[2] === 'ps') return [...rows.keys(), containerId].join('\n');
      if (args[2] === 'inspect' && rows.has(args.at(-1)!)) return JSON.stringify(rows.get(args.at(-1)!));
      return docker(...args);
    };
    assert.equal((await inspectAccountingProducers(options, command, () => now, exception)).producers.length, 4);
    assert.match(await docker('logs', containerId), /FAKE_TCP_OK/);
    await assert.rejects(inspectAccountingProducers(options, command, () => now, { ...exception, containerId: hash }));
    await docker('run', '--rm', '--network', 'none', '--name', intruder, '--entrypoint', 'node', imageId, '-e', 'process.exit(0)');
    await assert.rejects(watcher.flush(), /INVENTORY_UNAVAILABLE/);
  } finally {
    watcher.close();
    for (const container of [name, intruder]) await docker('rm', '-f', container).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test('isolated real Compose v2 launch is accepted by native inventory only with exact owned process binding',
  { skip: process.env.OWNER_RECOVERY_DOCKER_TEST !== '1' || process.platform !== 'darwin', timeout: 30000 }, async () => {
    const docker = async (...args: string[]) => (await exec('docker', args, { timeout: 10000, maxBuffer: 1024 * 1024 })).stdout;
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'owner-compose-native-')));
    const requestId = randomUUID(), name = `accounting-owner-recovery-${requestId}`, project = `owner-native-${randomUUID().slice(0, 8)}`;
    const context: string = JSON.parse(await docker('context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'));
    const imageId = (await docker('image', 'inspect', '--format', '{{.Id}}', process.env.OWNER_RECOVERY_TEST_IMAGE ?? 'node:24-bullseye-slim')).trim();
    const selectedDocker = await runRecoveryHostCommand('/usr/bin/which', ['docker']);
    assert.equal(selectedDocker.exitCode, 0);
    const executable = await realpath(selectedDocker.stdout.trim());
    const composePath = join(directory, 'compose.json');
    await writeFile(composePath, JSON.stringify({ services: { fixture: { image: imageId, network_mode: 'none', entrypoint: ['node'],
      command: ['-e', "process.stdout.write('COMPOSE_FIXTURE_READY\\n');setTimeout(()=>{},20000)"] } } }), { mode: 0o600 });
    const args = ['--host', context, 'compose', '-f', composePath, '-p', project, 'run', '--rm', '--no-deps', '-T', '--name', name, 'fixture'];
    const startedAt = new Date().toISOString(), child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error('fixture readiness timed out')), 10000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', () => { clearTimeout(timer); reject(new Error('fixture exited before ready')); });
        child.stdout.on('data', data => { output += String(data); if (output.includes('COMPOSE_FIXTURE_READY')) { clearTimeout(timer); resolve(); } });
      });
      assert.ok(child.pid);
      const launch: AccountingRecoveryNativeLaunch = { pid: child.pid, executable, args, startedAt };
      const kept = new Set<number>([process.pid, child.pid]);
      let pluginObserved = false;
      const command: InspectCommand = async (file, argv) => {
        if (file === '/usr/sbin/lsof') return null; // No broker endpoint is inspected by this fixture.
        const result = await runRecoveryHostCommand(file, argv);
        assert.equal(result.exitCode, 0); assert.equal(result.stderr, ''); command.lastPid = result.pid;
        if (file !== '/bin/ps') return result.stdout;
        const rows = result.stdout.trim().split('\n');
        if (argv.at(-1) === 'pid=,ppid=,lstart=,comm=') {
          for (const row of rows) {
            const match = row.match(/^\s*(\d+)\s+(\d+)/);
            if (match && Number(match[2]) === child.pid) { kept.add(Number(match[1])); pluginObserved ||= row.endsWith('/docker-compose'); }
          }
        }
        // Exercise real ps/helper churn and launch identities without inspecting unrelated host clients.
        return rows.filter(row => kept.has(Number(row.trim().split(/\s/)[0])) || Number(row.trim().split(/\s/)[0]) === result.pid).join('\n');
      };
      const options = { project, imageId, dockerHost: context, root: directory, host: 'host.docker.internal', port: 7497 };
      await assert.rejects(inspectAccountingNative(options, command, process.pid, null), /PRODUCERS_NOT_QUIESCENT/);
      const result = await inspectAccountingNative(options, command, process.pid, null, launch);
      assert.equal(pluginObserved, true); assert.equal(result.length, 1); assert.ok(launch.identities);
      await inspectAccountingNative(options, command, process.pid, null, launch);
      await assert.rejects(inspectAccountingNative(options, command, process.pid, null, { ...launch, pid: process.pid }), /PROCESS_CHANGED/);
    } finally {
      await docker('rm', '-f', name).catch(() => undefined); child.kill('SIGTERM'); await exited;
      await rm(directory, { recursive: true, force: true });
    }
  });
