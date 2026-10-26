import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createAccountingRecoveryHost, inspectAccountingProducers, inspectAccountingNative, createAccountingEventGuard, ACCOUNTING_APP_SERVICES } from './accounting-owner-recovery-host.js';
const hash = 'a'.repeat(64), imageId = `sha256:${hash}`, id = (n: number) => n.toString(16).padStart(64, '0');
const options = { project: 'fixture', imageId, dockerHost: 'unix:///var/run/docker.sock', root: '/repo', host: 'host.docker.internal', port: 7497 };
const time = '2026-10-19T12:00:00.000Z';
const executable = '/Users/operator/Applications/Trader Workstation/Trader Workstation.app/Contents/MacOS/JavaApplicationStub';
const nativeFormat = `pid=PID,ppid=PPID,lstart=START,comm=${'C'.repeat(1024)},args=ARGS`;
const nativeHeader = `  PID  PPID START${' '.repeat(24)}${'C'.repeat(1024)} ARGS`;
type NativeRow = { ppid: number; start: string; command: string; argv: string };
function nativeSnapshot(rows: Iterable<[number, NativeRow]>): string {
  return [nativeHeader, ...[...rows].map(([pid, row]) => `${String(pid).padStart(5)} ${String(row.ppid).padStart(5)} ${row.start.padEnd(28)} ${row.command.padEnd(1024)} ${row.argv}`)].join('\n') + '\n';
}
function inventoryFixture() {
  const containers = new Map<string, Record<string, unknown>>(ACCOUNTING_APP_SERVICES.slice(0, 4).map((service, i) => [id(i + 1), {
    Id: id(i + 1), Image: imageId, Name: `/fixture-${service}`, Config: { Labels: { 'com.docker.compose.project': 'fixture', 'com.docker.compose.service': service, 'com.docker.compose.oneoff': 'False' },
      Entrypoint: ['docker-entrypoint.sh'], Cmd: ['pnpm', '--filter', `@ikbr/${service}`, 'start'] },
    State: { Status: 'exited', Running: false, Paused: false, Restarting: false, Pid: 0, StartedAt: '2026-10-19T09:00:00Z', FinishedAt: '2026-10-19T10:00:00Z' },
  }]));
  const command = async (_file: string, args: readonly string[]) => {
    if (args[0] === 'context') return JSON.stringify(options.dockerHost);
    if (args[2] === 'info') return JSON.stringify({ OperatingSystem: 'Docker Desktop', OSType: 'linux' });
    if (args[2] === 'ps') return [...containers.keys()].join('\n');
    if (args[2] === 'inspect') return JSON.stringify(containers.get(args.at(-1)!));
    throw new Error('unexpected');
  };
  return { containers, command };
}
test('global stopped inventory includes all required services and accounts for absent optional services', async () => {
  const f = inventoryFixture(); const result = await inspectAccountingProducers(options, f.command, () => time);
  assert.equal(result.producers.length, 4); assert.deepEqual(result.absentServices, ['backtest-engine', 'ui']);
  f.containers.delete(id(1)); await assert.rejects(inspectAccountingProducers(options, f.command, () => time));
});
test('one-shot requires actual ID image command labels and running identity; name alone cannot exempt', async () => {
  const f = inventoryFixture(), requestId = '00000000-0000-4000-8000-000000000001', name = `accounting-owner-recovery-${requestId}`;
  const row = { Id: id(8), Image: imageId, Name: `/${name}`, Config: { Labels: { 'com.docker.compose.project': 'fixture', 'com.docker.compose.service': 'execution-engine', 'com.docker.compose.oneoff': 'True' }, Entrypoint: ['node'], Cmd: ['apps/execution-engine/dist/accounting/owner-recovery-cli.js'] }, State: { Running: true, Paused: false, Restarting: false } };
  f.containers.set(id(8), row);
  await assert.rejects(inspectAccountingProducers(options, f.command, () => time));
  const exception = { containerId: id(8), imageId, name, requestId };
  assert.equal((await inspectAccountingProducers(options, f.command, () => time, exception)).producers.length, 4);
  row.Config.Cmd = ['apps/execution-engine/dist/index.js'];
  await assert.rejects(inspectAccountingProducers(options, f.command, () => time, exception));
});
test('running, contradictory created, foreign project and unknown image instances cannot pass stopped inventory', async () => {
  for (const change of ['running', 'created', 'foreign', 'image']) {
    const f = inventoryFixture(), row = f.containers.get(id(1))!;
    if (change === 'image') row.Image = `sha256:${'b'.repeat(64)}`;
    else if (change === 'foreign') ((row.Config as { Labels: Record<string, string> }).Labels)['com.docker.compose.project'] = 'elsewhere';
    else (row.State as Record<string, unknown>).Status = change;
    await assert.rejects(inspectAccountingProducers(options, f.command, () => time));
  }
});
function createdInventoryFixture() {
  const f = inventoryFixture();
  for (const row of f.containers.values()) {
    row.Created = '2026-10-19T11:59:59.123456789Z';
    row.State = { Status: 'created', Running: false, Paused: false, Restarting: false, Pid: 0,
      StartedAt: '0001-01-01T00:00:00Z', FinishedAt: '0001-01-01T00:00:00Z' };
  }
  return f;
}
test('never-started core and optional containers retain explicit creation evidence without fabricated process times', async () => {
  const f = createdInventoryFixture();
  for (const [index, service] of ACCOUNTING_APP_SERVICES.slice(4).entries()) {
    const row = structuredClone(f.containers.get(id(1))!);
    row.Id = id(index + 5);
    const config = row.Config as { Labels: Record<string, string>; Cmd: string[] };
    config.Labels['com.docker.compose.service'] = service;
    config.Cmd = ['pnpm', '--filter', `@ikbr/${service}`, service === 'ui' ? 'dev' : 'start'];
    f.containers.set(id(index + 5), row);
  }
  const result = await inspectAccountingProducers(options, f.command, () => time);
  assert.equal(result.producers.length, 6); assert.deepEqual(result.absentServices, []);
  for (const producer of result.producers) {
    assert.equal(producer.state, 'created'); assert.equal(producer.startedAt, null); assert.equal(producer.finishedAt, null);
    assert.ok(producer.state === 'created'); assert.equal(producer.createdAt, '2026-10-19T11:59:59.123Z');
  }
  const old = inventoryFixture().containers.get(id(1))!;
  (old.State as Record<string, unknown>).Status = 'dead'; f.containers.set(id(1), old);
  const mixed = await inspectAccountingProducers(options, f.command, () => time);
  assert.equal(mixed.producers[0].state, 'dead'); assert.equal('createdAt' in mixed.producers[0], false);
  f.containers.delete(id(2)); await assert.rejects(inspectAccountingProducers(options, f.command, () => time));
});
test('created Docker branch denies unknown or contradictory process, date and deployment evidence', async () => {
  const mutations: Array<(row: Record<string, unknown>) => void> = [
    row => { delete row.Created; }, row => { row.Created = null; }, row => { row.Created = '2026-10-19T12:00:01Z'; },
    row => { row.Created = '2026-02-30T00:00:00Z'; }, row => { row.Created = 'not-a-date'; },
    ...['Running', 'Paused', 'Restarting'].flatMap(key => [
      (row: Record<string, unknown>) => { (row.State as Record<string, unknown>)[key] = true; },
      (row: Record<string, unknown>) => { delete (row.State as Record<string, unknown>)[key]; },
    ]),
    row => { (row.State as Record<string, unknown>).Pid = 1; }, row => { (row.State as Record<string, unknown>).Pid = '0'; },
    row => { delete (row.State as Record<string, unknown>).Pid; },
    ...['StartedAt', 'FinishedAt'].flatMap(key => [
      (row: Record<string, unknown>) => { (row.State as Record<string, unknown>)[key] = '2026-10-19T11:00:00Z'; },
      (row: Record<string, unknown>) => { (row.State as Record<string, unknown>)[key] = '0001-01-01T00:00:00.000Z'; },
      (row: Record<string, unknown>) => { (row.State as Record<string, unknown>)[key] = null; },
      (row: Record<string, unknown>) => { delete (row.State as Record<string, unknown>)[key]; },
    ]),
    row => { (row.State as Record<string, unknown>).Status = 'unknown'; }, row => { (row.State as Record<string, unknown>).Status = 'exited'; },
    row => { row.Image = `sha256:${'b'.repeat(64)}`; },
    row => { ((row.Config as { Labels: Record<string, string> }).Labels)['com.docker.compose.project'] = 'other'; },
    row => { ((row.Config as { Labels: Record<string, string> }).Labels)['com.docker.compose.service'] = 'unknown'; },
    row => { ((row.Config as { Labels: Record<string, string> }).Labels)['com.docker.compose.oneoff'] = 'true'; },
    row => { (row.Config as { Cmd: string[] }).Cmd = ['node', 'arbitrary.js']; },
    row => { (row.Config as { Entrypoint: string[] }).Entrypoint = ['node']; },
  ];
  for (const mutate of mutations) {
    const f = createdInventoryFixture(); mutate(f.containers.get(id(1))!);
    await assert.rejects(inspectAccountingProducers(options, f.command, () => time));
  }
  const f = createdInventoryFixture(), duplicate = structuredClone(f.containers.get(id(1))!);
  duplicate.Id = id(9); duplicate.Image = `sha256:${'b'.repeat(64)}`; f.containers.set(id(9), duplicate);
  await assert.rejects(inspectAccountingProducers(options, f.command, () => time));
});
test('created container replacement and lifecycle events invalidate the existing observation', async () => {
  const f = createdInventoryFixture();
  const host = createAccountingRecoveryHost(options, { platform: 'darwin', now: () => new Date(time), run: async (file, args) => {
    if (file === 'docker') return { stdout: await f.command(file, args), stderr: '', exitCode: 0 };
    if (file === '/usr/sbin/lsof') return { stdout: '', stderr: '', exitCode: 1 };
    if (file === '/usr/bin/shasum') return { stdout: `${hash}  /usr/bin/node\n`, stderr: '', exitCode: 0 };
    assert.deepEqual(args, ['-ww', '-axo', nativeFormat]);
    return { stdout: nativeSnapshot([[process.pid, { ppid: 0, start: 'Mon Oct 19 10:00:00 2026', command: '/usr/bin/node', argv: 'node collector' }]]), stderr: '', exitCode: 0 };
  } });
  const initial = await host.captureProducerInventory();
  await host.verifyProducerInventory(initial);
  const replacement = structuredClone(f.containers.get(id(1))!); replacement.Id = id(9);
  f.containers.delete(id(1)); f.containers.set(id(9), replacement);
  await assert.rejects(host.verifyProducerInventory(initial), /PRODUCER_REPLACED/);
  for (const action of ['create', 'start', 'stop', 'destroy']) {
    const watcher = createAccountingEventGuard(undefined);
    watcher.consume(JSON.stringify({ Type: 'container', Action: action, Actor: { ID: id(1), Attributes: { name: 'created-producer' } } }));
    assert.throws(watcher.check, /INVENTORY_UNAVAILABLE/);
  }
});
test('event guard detects start-stop between snapshots and pins provisional one-shot events retrospectively', () => {
  const event = (action: string, containerId = id(2), name = 'writer') => JSON.stringify({ Type: 'container', Action: action, Actor: { ID: containerId, Attributes: { name } } });
  const guard = createAccountingEventGuard(undefined); guard.consume(event('start')); guard.consume(event('die')); assert.throws(guard.check);
  const requestId = '00000000-0000-4000-8000-000000000001', name = `accounting-owner-recovery-${requestId}`;
  const own = createAccountingEventGuard(name); own.consume(event('create', id(7), name)); own.consume(event('start', id(7), name));
  own.allow({ containerId: id(7), imageId, requestId, name }); own.check(); own.consume(event('die', id(7), name)); own.check();
  const forged = createAccountingEventGuard(name); forged.consume(event('start', id(8), name)); forged.allow({ containerId: id(7), imageId, requestId, name }); assert.throws(forged.check);
  const lost = createAccountingEventGuard(undefined); lost.fail(); assert.throws(lost.check);
});
function processFixture() {
  let clock = Date.parse(time), phase = 'before', oldSurvives = false, product = executable;
  const host = createAccountingRecoveryHost(options, { platform: 'darwin', now: () => new Date(clock++), run: async (file, args) => {
    if (file === '/usr/sbin/lsof') return phase === 'stopped' ? { stdout: '', stderr: '', exitCode: 1 } : { stdout: `p${phase === 'before' ? 101 : 202}\nf13\nn*:7497\n`, stderr: '', exitCode: 0 };
    if (file === '/bin/ps') {
      const pid = Number(args[2]); if (pid === 101 && phase !== 'before' && !oldSurvives) return { stdout: '', stderr: '', exitCode: 1 };
      return { stdout: args.at(-1) === 'comm=' ? product : pid === 101 ? 'Mon Oct 19 10:00:00 2026' : 'Mon Oct 19 12:00:05 2026', stderr: '', exitCode: 0 };
    }
    if (file === '/usr/bin/shasum') return { stdout: `${hash}  ${product}\n`, stderr: '', exitCode: 0 };
    throw new Error('unexpected');
  } });
  return { host, phase: (v: string) => { phase = v; clock += 3000; }, survive: () => { oldSurvives = true; }, gateway: () => { product = '/Applications/IB Gateway.app/Contents/MacOS/JavaApplicationStub'; } };
}
test('whole TWS reset requires old process+listener absence and a distinct later process', async () => {
  const f = processFixture(), before = await f.host.captureGatewayProcess();
  await assert.rejects(f.host.assertGatewayStopped(before));
  f.phase('stopped'); await f.host.assertGatewayStopped(before); f.phase('after');
  const after = await f.host.verifyGatewayReplacement(before); assert.equal(after.process.pid, 202);
  f.survive(); await assert.rejects(f.host.verifyGatewayReplacement(before));
});
test('pre-observation stop, Gateway product and unsupported host topology deny', async () => {
  const stopped = processFixture(); stopped.phase('stopped'); await assert.rejects(stopped.host.captureGatewayProcess());
  const gateway = processFixture(); gateway.gateway(); await assert.rejects(gateway.host.captureGatewayProcess());
  const noAbsence = processFixture(), before = await noAbsence.host.captureGatewayProcess(); noAbsence.phase('after'); await assert.rejects(noAbsence.host.verifyGatewayReplacement(before));
  assert.throws(() => createAccountingRecoveryHost({ ...options, host: 'remote.example' }, { platform: 'darwin' }));
  assert.throws(() => createAccountingRecoveryHost(options, { platform: 'linux' }));
});
test('native candidate and endpoint client recognition deny; unrelated Node argv is allowed', async () => {
  let args = 'node /tmp/editor.js', socket = '';
  const command = async (file: string, argv: readonly string[]) => {
    if (file === '/bin/ps') {
      assert.deepEqual(argv, ['-ww', '-axo', nativeFormat]);
      return nativeSnapshot([[1, { ppid: 0, start: 'Mon Oct 19 10:00:00 2026', command: '/usr/bin/node', argv: 'node /repo/accounting-owner-recovery-cli.ts' }],
        [2, { ppid: 0, start: 'Mon Oct 19 10:00:00 2026', command: '/usr/bin/node', argv: args }]]);
    }
    if (file === '/usr/bin/shasum') return `${hash}  /usr/bin/node\n`;
    if (file === '/usr/sbin/lsof') return socket || null;
    throw new Error('unexpected');
  };
  await inspectAccountingNative(options, command, 1, null);
  for (const candidate of ['python /tmp/ibapi/client.py', 'node /repo/unrelated.js', 'pnpm --filter @ikbr/signal-engine start',
    'node /tmp/execution-engine/dist/index.js', 'node /tmp/ingestion/src/main.ts', 'node /tmp/llm-agent/dist/index.js',
    'node /tmp/backtest-engine/src/index.ts', 'node /tmp/@stoqey/ib/client.js']) {
    args = candidate; await assert.rejects(inspectAccountingNative(options, command, 1, null), /PRODUCERS_NOT_QUIESCENT/);
  }
  args = 'node /tmp/editor.js'; socket = 'p2\nf3\nn127.0.0.1:7497'; await assert.rejects(inspectAccountingNative(options, command, 1, null));
});

function nativeComposeFixture() {
  const own = 100, docker = 200, plugin = 201;
  const dockerPath = '/Applications/Docker.app/Contents/Resources/bin/docker', pluginPath = '/Users/operator/.docker/cli-plugins/docker-compose';
  const args = ['--host', options.dockerHost, 'compose', '-f', '/repo/compose.yaml', 'run', '--rm', '--no-deps', '-T',
    '--name', 'accounting-owner-recovery-00000000-0000-4000-8000-000000000001', '--entrypoint', 'node', 'execution-engine', 'apps/execution-engine/dist/accounting/owner-recovery-cli.js'];
  const launch: import('./accounting-owner-recovery-host.js').AccountingRecoveryNativeLaunch = { pid: docker, executable: dockerPath, args, startedAt: '2026-10-19T10:00:01.500Z' };
  const rows = new Map([
    [own, { ppid: 0, start: 'Mon Oct 19 10:00:00 2026', command: '/usr/bin/node', argv: 'node /repo/accounting-owner-recovery-cli.ts' }],
    [docker, { ppid: own, start: 'Mon Oct 19 10:00:01 2026', command: dockerPath, argv: [dockerPath, ...args].join(' ') }],
    [plugin, { ppid: docker, start: 'Mon Oct 19 10:00:02 2026', command: pluginPath, argv: [pluginPath, ...args].join(' ') }],
  ]);
  let digest = hash, socket: string | null = null;
  const command = async (file: string, args: readonly string[]) => {
    if (file === '/bin/ps') { assert.deepEqual(args, ['-ww', '-axo', nativeFormat]); return nativeSnapshot(rows); }
    if (file === '/usr/bin/shasum') return `${digest}  ${args.at(-1)}\n`;
    if (file === '/usr/sbin/lsof') return socket;
    throw new Error('unexpected');
  };
  return { own, docker, plugin, launch, rows, command, changeHash: () => { digest = 'b'.repeat(64); },
    socket: () => { socket = `p${plugin}\nf3\nn127.0.0.1:7497`; } };
}
test('native Compose v2 exception pins actual launch and its unique direct plugin with inherited args', async () => {
  const f = nativeComposeFixture();
  await assert.rejects(inspectAccountingNative(options, f.command, f.own, null), /PRODUCERS_NOT_QUIESCENT/);
  assert.equal((await inspectAccountingNative(options, f.command, f.own, null, f.launch)).length, 1);
  assert.ok(f.launch.identities);
  await inspectAccountingNative(options, f.command, f.own, null, f.launch);
  f.socket(); await assert.rejects(inspectAccountingNative(options, f.command, f.own, null, f.launch), /PRODUCERS_NOT_QUIESCENT/);
});
test('native Compose exemption rejects sibling spoofs, unknown descendants, wrong ancestry, argv and reused identities', async () => {
  for (const mode of ['docker-sibling', 'plugin-sibling', 'wrong-parent', 'parent-argv', 'plugin-argv', 'cycle', 'early-plugin',
    'early-launch', 'hash-change', 'pid-reuse', 'plugin-replacement', 'extra-descendant', 'second-plugin']) {
    const f = nativeComposeFixture();
    await inspectAccountingNative(options, f.command, f.own, null, f.launch);
    const parent = f.rows.get(f.docker)!, plugin = f.rows.get(f.plugin)!;
    if (mode === 'docker-sibling') f.rows.set(300, { ...parent });
    if (mode === 'plugin-sibling') f.rows.set(300, { ...plugin, ppid: f.own });
    if (mode === 'wrong-parent') plugin.ppid = f.own;
    if (mode === 'parent-argv') parent.argv += ' --unknown';
    if (mode === 'plugin-argv') plugin.argv += ' --unknown';
    if (mode === 'cycle') parent.ppid = f.plugin;
    if (mode === 'early-plugin') plugin.start = 'Mon Oct 19 09:59:59 2026';
    if (mode === 'early-launch') parent.start = 'Mon Oct 19 09:59:59 2026';
    if (mode === 'hash-change') f.changeHash();
    if (mode === 'pid-reuse') parent.start = 'Mon Oct 19 10:00:03 2026';
    if (mode === 'plugin-replacement') { f.rows.delete(f.plugin); f.rows.set(301, { ...plugin }); }
    if (mode === 'extra-descendant') f.rows.set(300, { ...parent, ppid: f.plugin });
    if (mode === 'second-plugin') f.rows.set(300, { ...plugin });
    await assert.rejects(inspectAccountingNative(options, f.command, f.own, null, f.launch), /PROCESS_CHANGED|PRODUCERS_NOT_QUIESCENT/, mode);
  }
});

test('one complete native snapshot preserves spaced paths, marker strings and trailing argv without a second global view', async () => {
  const f = nativeComposeFixture();
  const path = '/Applications/An application with a long path/Contents/MacOS/node';
  const args = `${path} ARGS ${'C'.repeat(1024)} final argument  `;
  f.rows.get(f.own)!.command = path; f.rows.get(f.own)!.argv = args;
  let views = 0;
  const command: typeof f.command = async (file, argv) => { if (file === '/bin/ps') views++; return f.command(file, argv); };
  const result = await inspectAccountingNative(options, command, f.own, null, f.launch);
  assert.equal(views, 1); assert.equal(result[0].argvHash, createHash('sha256').update(args).digest('hex'));
});

test('native framing rejects incomplete, ambiguous, saturated and oversized snapshots without ignoring any row', async () => {
  const f = nativeComposeFixture(), original = nativeSnapshot(f.rows), rows = original.trimEnd().split('\n');
  const mutations: Record<string, string> = {
    'no-header': rows.slice(1).join('\n') + '\n',
    'wrong-header': original.replace('START', 'OTHER'),
    'duplicate-header': original + nativeHeader + '\n',
    'no-rows': nativeHeader + '\n',
    'missing-final-newline': original.slice(0, -1),
    'duplicate-pid': original + rows[1] + '\n',
    'missing-collector': [rows[0], ...rows.slice(2)].join('\n') + '\n',
    'zero-pid': original.replace('  100', '    0'),
    'negative-ppid': original.replace('  100     0', '  100    -1'),
    'invalid-date': original.replace('Mon Oct 19', 'Mon Feb 30'),
    'wrong-weekday': original.replace('Mon Oct 19', 'Tue Oct 19'),
    'short-row': original + '  300\n',
    'extra-blank-row': original + '\n',
    'tab': original.replace('node', 'no\tde'),
    'carriage-return': original.replace('node', 'no\rde'),
    'nul': original.replace('node', 'no\0de'),
    'multibyte-boundary': original.replace('node', 'nødé'),
    'misaligned-separator': [rows[0], rows[1].slice(0, 1065) + 'X' + rows[1].slice(1066), ...rows.slice(2)].join('\n') + '\n',
    'oversized-output': original + 'x'.repeat(2 * 1024 * 1024) + '\n',
  };
  for (const [name, output] of Object.entries(mutations)) {
    const command: typeof f.command = async (file, args) => file === '/bin/ps' ? output : f.command(file, args);
    await assert.rejects(inspectAccountingNative(options, command, f.own, null, f.launch), /INVENTORY_UNAVAILABLE/, name);
  }
  for (const mode of ['empty-command', 'empty-argv', 'saturated-command', 'oversized-command', 'leading-command-space']) {
    const fixture = nativeComposeFixture(), own = fixture.rows.get(fixture.own)!;
    if (mode === 'empty-command') own.command = '';
    if (mode === 'empty-argv') own.argv = '   ';
    if (mode === 'saturated-command') own.command = '/' + 'a'.repeat(1023);
    if (mode === 'oversized-command') own.command = '/' + 'a'.repeat(1024);
    if (mode === 'leading-command-space') own.command = ' /usr/bin/node';
    await assert.rejects(inspectAccountingNative(options, fixture.command, fixture.own, null, fixture.launch), /INVENTORY_UNAVAILABLE/, mode);
  }
});

test('padded oversized argv0 cannot acquire a launch or helper exception', async () => {
  for (const mode of ['docker', 'plugin', 'helper-sibling', 'recovery-sibling']) {
    const f = nativeComposeFixture();
    if (mode === 'docker' || mode === 'plugin') {
      const row = f.rows.get(mode === 'docker' ? f.docker : f.plugin)!;
      row.argv = row.command + ' '.repeat(1100) + 'hidden-argv0 /repo/client';
    } else {
      f.rows.set(300, { ppid: 0, start: 'Mon Oct 19 10:00:00 2026', command: '/bin/ps',
        argv: mode === 'helper-sibling' ? '/bin/ps /repo/client' : 'node /repo/accounting-owner-recovery-cli.ts' });
    }
    await assert.rejects(inspectAccountingNative(options, f.command, f.own, null, f.launch), /PROCESS_CHANGED|PRODUCERS_NOT_QUIESCENT/, mode);
  }
});

test('real macOS unfiltered native snapshots survive unrelated process churn and preserve a spaced executable path',
  { skip: process.env.OWNER_RECOVERY_NATIVE_TEST !== '1' || process.platform !== 'darwin', timeout: 30000 }, async () => {
    const { runRecoveryHostCommand } = await import('./accounting-owner-recovery-host.js');
    const { spawn } = await import('node:child_process');
    const { mkdtemp, mkdir, realpath, symlink, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'owner-native-format-')));
    const path = join(directory, 'long executable directory ' + 'a'.repeat(80), 'sleep with spaces');
    await mkdir(join(path, '..')); await symlink('/bin/sleep', path);
    const child = spawn(path, ['30'], { stdio: 'ignore' });
    const exited = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', () => resolve()); });
    let stop = false, churned = 0, snapshots = 0, minimumRows = Infinity;
    const churn = (async () => {
      while (!stop && churned < 1000) {
        const process = spawn('/bin/sleep', ['0.01'], { stdio: 'ignore' });
        await new Promise<void>((resolve, reject) => { process.once('error', reject); process.once('close', () => resolve()); });
        churned++;
      }
    })();
    try {
      assert.ok(child.pid);
      const command: import('./accounting-owner-recovery-host.js').InspectCommand = async (file, args) => {
        if (file === '/usr/sbin/lsof') return null; // This parser fixture never inspects a broker endpoint.
        const result = await runRecoveryHostCommand(file, args);
        assert.equal(result.exitCode, 0); assert.equal(result.stderr, '');
        if (file === '/bin/ps') {
          assert.deepEqual(args, ['-ww', '-axo', nativeFormat]); snapshots++;
          minimumRows = Math.min(minimumRows, result.stdout.split('\n').length - 2);
        }
        return result.stdout;
      };
      for (let sample = 0; sample < 8; sample++) {
        const result = await inspectAccountingNative({ ...options, root: '/isolated-native-fixture' }, command, process.pid, child.pid);
        assert.deepEqual(result.map(row => row.pid), [process.pid, child.pid]);
        assert.equal(result[1].argvHash, createHash('sha256').update(`${path} 30`).digest('hex'));
      }
      assert.equal(snapshots, 8); assert.ok(minimumRows > 3); assert.ok(churned > 1);
    } finally {
      stop = true; await churn; child.kill('SIGTERM'); await exited; await rm(directory, { recursive: true, force: true });
    }
  });
