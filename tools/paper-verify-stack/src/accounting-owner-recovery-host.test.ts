import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountingRecoveryHost, inspectAccountingProducers, inspectAccountingNative, createAccountingEventGuard, ACCOUNTING_APP_SERVICES } from './accounting-owner-recovery-host.js';
const hash = 'a'.repeat(64), imageId = `sha256:${hash}`, id = (n: number) => n.toString(16).padStart(64, '0');
const options = { project: 'fixture', imageId, dockerHost: 'unix:///var/run/docker.sock', root: '/repo', host: 'host.docker.internal', port: 7497 };
const time = '2026-10-19T12:00:00.000Z';
const executable = '/Users/operator/Applications/Trader Workstation/Trader Workstation.app/Contents/MacOS/JavaApplicationStub';
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
test('running, created, foreign project and unknown image instances cannot pass stopped inventory', async () => {
  for (const change of ['running', 'created', 'foreign', 'image']) {
    const f = inventoryFixture(), row = f.containers.get(id(1))!;
    if (change === 'image') row.Image = `sha256:${'b'.repeat(64)}`;
    else if (change === 'foreign') ((row.Config as { Labels: Record<string, string> }).Labels)['com.docker.compose.project'] = 'elsewhere';
    else (row.State as Record<string, unknown>).Status = change;
    await assert.rejects(inspectAccountingProducers(options, f.command, () => time));
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
    if (file === '/bin/ps') return argv.at(-1) === 'pid=,args='
      ? `1 node /repo/accounting-owner-recovery-cli.ts\n2 ${args}`
      : '1 0 Mon Oct 19 10:00:00 2026 /usr/bin/node\n2 0 Mon Oct 19 10:00:00 2026 /usr/bin/node';
    if (file === '/usr/bin/shasum') return `${hash}  /usr/bin/node\n`;
    if (file === '/usr/sbin/lsof') return socket || null;
    throw new Error('unexpected');
  };
  await inspectAccountingNative(options, command, 1, null);
  args = 'python /tmp/ibapi/client.py'; await assert.rejects(inspectAccountingNative(options, command, 1, null));
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
    if (file === '/bin/ps') return [...rows].map(([pid, row]) => args.at(-1) === 'pid=,args='
      ? `${pid} ${row.argv}` : `${pid} ${row.ppid} ${row.start} ${row.command}`).join('\n');
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

test('only the exact spawned first ps helper may disappear between complete native views', async () => {
  const { inspectAccountingNative } = await import('./accounting-owner-recovery-host.js');
  const own = 101, first = 201, second = 202;
  const command: import('./accounting-owner-recovery-host.js').InspectCommand = async (file, args) => {
    if (file === '/bin/ps' && args.at(-1) === 'pid=,ppid=,lstart=,comm=') {
      command.lastPid = first;
      return `${own} 0 Mon Oct 19 10:00:00 2026 /usr/bin/node\n${first} ${own} Mon Oct 19 10:00:01 2026 /bin/ps`;
    }
    if (file === '/bin/ps') { command.lastPid = second; return `${own} node collector\n${second} /bin/ps -ww -axo pid=,args=`; }
    if (file === '/usr/bin/shasum') return `${hash}  /usr/bin/node\n`;
    if (file === '/usr/sbin/lsof') return null;
    throw new Error('unexpected');
  };
  assert.equal((await inspectAccountingNative(options, command, own, null))[0].pid, own);
  for (const mutation of ['unbound-first-pid', 'wrong-first-parent', 'wrong-first-executable', 'unbound-second-pid', 'wrong-second-argv']) {
    const bad: typeof command = async (file, args, absent) => {
      let value = await command(file, args, absent); bad.lastPid = command.lastPid;
      if (file === '/bin/ps' && args.at(-1) === 'pid=,ppid=,lstart=,comm=') {
        if (mutation === 'unbound-first-pid') bad.lastPid = 999;
        if (mutation === 'wrong-first-parent') value = value!.replace(`${first} ${own}`, `${first} 999`);
        if (mutation === 'wrong-first-executable') value = value!.replace('/bin/ps', '/usr/bin/python');
      } else if (file === '/bin/ps') {
        if (mutation === 'unbound-second-pid') bad.lastPid = 999;
        if (mutation === 'wrong-second-argv') value = value!.replace('/bin/ps -ww -axo pid=,args=', '/bin/ps -E');
      }
      return value;
    };
    await assert.rejects(inspectAccountingNative(options, bad, own, null), /INVENTORY_UNAVAILABLE/, mutation);
  }
});

test('real macOS ps runner tolerates its own exact helper churn without broker inspection', { skip: process.env.OWNER_RECOVERY_NATIVE_TEST !== '1' || process.platform !== 'darwin' }, async () => {
  const { runRecoveryHostCommand } = await import('./accounting-owner-recovery-host.js');
  let firstPid: number | undefined, disappeared = false;
  const command: import('./accounting-owner-recovery-host.js').InspectCommand = async (file, args) => {
    if (file === '/usr/sbin/lsof') return null;
    const result = await runRecoveryHostCommand(file, args);
    assert.equal(result.exitCode, 0); assert.equal(result.stderr, ''); command.lastPid = result.pid;
    if (file !== '/bin/ps') return result.stdout;
    const rows = result.stdout.trim().split('\n');
    if (args.at(-1) === 'pid=,ppid=,lstart=,comm=') firstPid = result.pid;
    else disappeared = !rows.some(row => Number(row.trim().split(/\s/)[0]) === firstPid);
    // Keep real collector and actual spawned helper rows; unrelated native clients
    // are outside this isolated parser fixture, and no raw argv leaves this process.
    return rows.filter(row => [process.pid, result.pid].includes(Number(row.trim().split(/\s/)[0]))).join('\n');
  };
  const result = await inspectAccountingNative({ ...options, root: '/isolated-native-fixture' }, command, process.pid, null);
  assert.equal(disappeared, true); assert.equal(result.length, 1); assert.equal(result[0].pid, process.pid);
});
