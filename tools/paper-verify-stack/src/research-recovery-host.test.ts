import assert from 'node:assert/strict';
import test from 'node:test';
import { createResearchRecoveryHost, type RecoveryHostCommandRunner, type RecoveryHostCommandResult } from './research-recovery-host.js';

const id = 'a'.repeat(64), imageId = `sha256:${'b'.repeat(64)}`;
const executable = '/Users/operator/Applications/Trader Workstation/Trader Workstation.app/Contents/MacOS/JavaApplicationStub';
const digest = 'c'.repeat(64);
const options = { project: 'ikbr-trader', imageId, host: 'host.docker.internal', port: 7497 };
const good = (stdout: string): RecoveryHostCommandResult => ({ stdout, stderr: '', exitCode: 0 });
const absent: RecoveryHostCommandResult = { stdout: '', stderr: '', exitCode: 1 };
function fixture() {
  let time = Date.parse('2026-10-19T12:00:00Z');
  const state = {
    phase: 'before' as 'before' | 'stopped' | 'after', oldSurvives: false, reused: false, oldStart: 'Mon Oct 19 10:00:00 2026',
    newStart: 'Mon Oct 19 12:00:00 2026', executable, listenerExtra: '', context: 'unix:///Users/operator/.docker/run/docker.sock',
    ids: [id], containers: new Map<string, { project: string; service: string; image: string; status: string; running: boolean; oneoff?: unknown; entrypoint?: unknown; cmd?: unknown }>(),
    override: undefined as ((file: string, args: readonly string[]) => RecoveryHostCommandResult | undefined) | undefined,
  };
  state.containers.set(id, { project: options.project, service: 'llm-agent', image: imageId, status: 'exited', running: false });
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const run: RecoveryHostCommandRunner = async (file, args) => {
    calls.push({ file, args });
    const override = state.override?.(file, args); if (override) return override;
    if (file === 'docker') {
      if (args[0] === '--host') args = args.slice(2);
      if (args[0] === 'context') return good(JSON.stringify(state.context));
      if (args[0] === 'ps') return good(state.ids.join('\n') + '\n');
      if (args[0] === 'inspect' && args[2] === 'image') return good(JSON.stringify(['docker-entrypoint.sh']));
      if (args[0] === 'inspect') {
        const cid = args.at(-1)!, row = state.containers.get(cid)!;
        return good([cid, row.image, { 'com.docker.compose.project': row.project, 'com.docker.compose.service': row.service, 'com.docker.compose.oneoff': row.oneoff === undefined ? 'False' : row.oneoff },
          { Status: row.status, Running: row.running, Paused: false, Restarting: false, Pid: row.running ? 123 : 0,
            StartedAt: '2026-10-19T09:00:00.000000123Z', FinishedAt: '2026-10-19T10:00:00.000000123Z' }, row.entrypoint === undefined ? ['docker-entrypoint.sh'] : row.entrypoint,
          row.cmd === undefined ? ['pnpm', '--filter', `@ikbr/${row.service}`, row.service === 'ui' ? 'dev' : 'start'] : row.cmd].map(value => JSON.stringify(value)).join('\t') + '\n');
      }
    }
    if (file === '/usr/sbin/ioreg') return good('"IOPlatformUUID" = "12345678-1234-1234-1234-123456789abc"\n');
    if (file === '/usr/sbin/lsof') {
      if (state.phase === 'stopped') return absent;
      return good(`p${state.phase === 'before' || state.reused ? 101 : 202}\nf13\nn*:7497\n${state.listenerExtra}`);
    }
    if (file === '/bin/ps') {
      const pid = Number(args[2]);
      const alive = pid === 101 ? state.phase === 'before' || state.oldSurvives || (state.phase === 'after' && state.reused) : state.phase === 'after';
      if (!alive) return absent;
      if (args.at(-1) === 'comm=') return good(`${state.executable}\n`);
      return good(`${pid === 101 && !state.reused ? state.oldStart : state.newStart}\n`);
    }
    if (file === '/usr/bin/shasum') return good(`${digest}  ${state.executable}\n`);
    throw new Error(`Unexpected inspection: ${file} ${args.join(' ')}`);
  };
  const host = createResearchRecoveryHost(options, { run, platform: 'darwin', now: () => new Date(time++) });
  return { state, calls, host, advance: (ms: number) => { time += ms; } };
}
const code = (expected: string) => (error: unknown) => error instanceof Error && error.message === expected;

test('collects bounded stopped deployment and exact before/absent/after Gateway lifecycle', async () => {
  const { state, calls, host } = fixture();
  assert.match(await host.hostIdentityHash(), /^[a-f0-9]{64}$/);
  const inventory = await host.captureProducerInventory();
  assert.equal(inventory.producers[0].state, 'exited');
  assert.equal(inventory.producers[0].startedAt, '2026-10-19T09:00:00.000Z');
  const before = await host.captureGatewayProcess();
  assert.deepEqual(before.process, { pid: 101, startIdentity: '2026-10-19T10:00:00.000Z', executableHash: digest });
  state.phase = 'stopped';
  const stopped = await host.assertGatewayStopped(before);
  assert.equal(stopped.processAbsent, true);
  assert.equal(stopped.listenerAbsent, true);
  state.phase = 'after';
  assert.equal((await host.verifyGatewayReplacement(before)).process.pid, 202);
  assert.deepEqual((await host.verifyProducerInventory(inventory)).producers, inventory.producers);
  assert.ok(calls.every(call => ['docker', '/usr/sbin/ioreg', '/usr/sbin/lsof', '/bin/ps', '/usr/bin/shasum'].includes(call.file)));
  assert.ok(calls.filter(call => call.file === 'docker').every(call => ['context', 'ps', 'inspect'].includes(call.args[0] === '--host' ? call.args[2] : call.args[0])));
  assert.ok(calls.every(call => !call.args.includes('sh') && !call.args.includes('exec') && !call.args.includes('restart')));
});

test('remote/platform/port/project/external-producer capabilities fail closed before native commands', () => {
  for (const change of [{ host: 'remote.example' }, { host: '127.0.0.2' }, { host: 'host.docker.internal.attacker' }, { port: 0 }, { port: 7497.1 }, { project: 'x;command' }, { imageId: 'latest' }]) {
    assert.throws(() => createResearchRecoveryHost({ ...options, ...change }, { platform: 'darwin' }));
  }
  assert.throws(() => createResearchRecoveryHost(options, { platform: 'linux' }));
  assert.throws(() => createResearchRecoveryHost(options, { platform: 'darwin', knownExternalProducers: true }));
});

test('surviving process and not-yet-started process produce explicit pending errors', async () => {
  const { state, host } = fixture();
  const before = await host.captureGatewayProcess();
  await assert.rejects(host.assertGatewayStopped(before), code('RESEARCH_RECOVERY_GATEWAY_STILL_RUNNING'));
  state.phase = 'stopped'; state.oldSurvives = true;
  await assert.rejects(host.assertGatewayStopped(before), code('RESEARCH_RECOVERY_GATEWAY_STILL_RUNNING'));
  state.oldSurvives = false;
  await host.assertGatewayStopped(before);
  await assert.rejects(host.verifyGatewayReplacement(before), code('RESEARCH_RECOVERY_GATEWAY_NOT_STARTED'));
  state.phase = 'after'; state.oldSurvives = true;
  await assert.rejects(host.verifyGatewayReplacement(before), code('RESEARCH_RECOVERY_OLD_PROCESS_SURVIVED'));
});

test('new listener without independently observed disappearance and fabricated before evidence reject', async () => {
  const { state, host } = fixture(); const before = await host.captureGatewayProcess();
  state.phase = 'after';
  await assert.rejects(host.verifyGatewayReplacement(before), code('RESEARCH_RECOVERY_OBSERVATION_SEQUENCE'));
  await assert.rejects(host.assertGatewayStopped(before), code('RESEARCH_RECOVERY_OBSERVATION_SEQUENCE'));
  await assert.rejects(host.assertGatewayStopped({ ...before, process: { ...before.process, executableHash: 'd'.repeat(64) } }));
  await assert.rejects(host.assertGatewayStopped(before, 4002), code('RESEARCH_RECOVERY_ENDPOINT_CHANGED'));
});

test('PID reuse and equal creation identity do not prove a replacement', async () => {
  const reused = fixture(); const before = await reused.host.captureGatewayProcess();
  reused.state.phase = 'stopped'; await reused.host.assertGatewayStopped(before);
  reused.state.phase = 'after'; reused.state.reused = true;
  await assert.rejects(reused.host.verifyGatewayReplacement(before), code('RESEARCH_RECOVERY_OLD_PROCESS_SURVIVED'));
  const same = fixture(); const prior = await same.host.captureGatewayProcess();
  same.state.phase = 'stopped'; await same.host.assertGatewayStopped(prior);
  same.state.phase = 'after'; same.state.newStart = same.state.oldStart;
  await assert.rejects(same.host.verifyGatewayReplacement(prior), code('RESEARCH_RECOVERY_PROCESS_NOT_REPLACED'));
});

test('proxy executable, ambiguous listener and nonlocal listener addresses reject', async () => {
  for (const path of ['/usr/bin/ssh', '/usr/bin/java', '/opt/homebrew/bin/socat', '/Users/operator/Applications/Other.app/Contents/MacOS/JavaApplicationStub']) {
    const f = fixture(); f.state.executable = path;
    await assert.rejects(f.host.captureGatewayProcess(), code('RESEARCH_RECOVERY_LISTENER_NOT_GATEWAY'));
  }
  for (const extra of ['p303\nf14\nn*:7497\n', 'f14\nn10.0.0.1:7497\n', 'n*:4002\n', 'Xunknown\n']) {
    const f = fixture(); f.state.listenerExtra = extra;
    await assert.rejects(f.host.captureGatewayProcess(), code('RESEARCH_RECOVERY_LISTENER_AMBIGUOUS'));
  }
});

test('inspection output errors, limits and malformed absence fail closed', async () => {
  for (const output of [good('x'.repeat(32769)), { stdout: '', stderr: 'permission denied', exitCode: 1 }, { stdout: 'partial', stderr: '', exitCode: 1 }, good('p101\0')]) {
    const f = fixture(); f.state.override = file => file === '/usr/sbin/lsof' ? output : undefined;
    await assert.rejects(f.host.captureGatewayProcess(), code('RESEARCH_RECOVERY_INSPECTION_UNAVAILABLE'));
  }
});

test('Docker remote context, unknown deployments, active/dead-running and incomplete inventory reject', async () => {
  const remote = fixture(); remote.state.context = 'ssh://server';
  await assert.rejects(remote.host.captureProducerInventory());
  for (const change of [{ project: 'external' }, { service: 'unknown' }, { image: `sha256:${'e'.repeat(64)}` }, { status: 'running', running: true }, { status: 'dead', running: true }, { status: 'created' }]) {
    const f = fixture(); Object.assign(f.state.containers.get(id)!, change);
    await assert.rejects(f.host.captureProducerInventory());
  }
  const empty = fixture(); empty.state.ids = [];
  await assert.rejects(empty.host.captureProducerInventory());
});

test('second inspection detects replacement even when it already stopped and rejects changed prior evidence', async () => {
  const f = fixture(); const prior = await f.host.captureProducerInventory();
  const replacement = 'd'.repeat(64); f.state.ids.push(replacement);
  f.state.containers.set(replacement, { ...f.state.containers.get(id)! });
  await assert.rejects(f.host.verifyProducerInventory(prior), code('RESEARCH_RECOVERY_PRODUCER_REPLACED'));
  await assert.rejects(f.host.verifyProducerInventory({ ...prior, producers: [] }), code('RESEARCH_RECOVERY_OBSERVATION_SEQUENCE'));
});

test('known other services sharing image are not classified as producers', async () => {
  const f = fixture(); const other = 'd'.repeat(64); f.state.ids.push(other);
  f.state.containers.set(other, { ...f.state.containers.get(id)!, service: 'execution-engine', status: 'running', running: true });
  assert.equal((await f.host.captureProducerInventory()).producers.length, 1);
});

test('host clock rollback and observation deadline fail closed', async () => {
  const rollback = fixture(); await rollback.host.hostIdentityHash(); rollback.advance(-100);
  await assert.rejects(rollback.host.captureProducerInventory(), code('RESEARCH_RECOVERY_OBSERVATION_EXPIRED'));
  const expired = fixture(); expired.advance(900_001);
  await assert.rejects(expired.host.captureProducerInventory(), code('RESEARCH_RECOVERY_OBSERVATION_EXPIRED'));
});


test('preexisting second process cannot become replacement by later acquiring listener', async () => {
  const f = fixture(); const before = await f.host.captureGatewayProcess();
  f.state.phase = 'stopped'; await f.host.assertGatewayStopped(before);
  f.state.phase = 'after'; f.state.newStart = 'Mon Oct 19 11:59:59 2026';
  await assert.rejects(f.host.verifyGatewayReplacement(before), code('RESEARCH_RECOVERY_PROCESS_NOT_REPLACED'));
});

test('producer inventory limit and missing inspection records are rejected', async () => {
  const f = fixture();
  f.state.ids = Array.from({ length: 17 }, (_, i) => i.toString(16).padStart(64, '0'));
  for (const key of f.state.ids) f.state.containers.set(key, { ...f.state.containers.get(id)! });
  await assert.rejects(f.host.captureProducerInventory(), code('RESEARCH_RECOVERY_PRODUCER_INVENTORY_UNSUPPORTED'));
  const missing = fixture();
  missing.state.override = (file, args) => file === 'docker' && args.includes('inspect') && args.includes('--type') ? good('[]') : undefined;
  await assert.rejects(missing.host.captureProducerInventory());
});


test('Docker endpoint is pinned across observations and against expected deployment', async () => {
  const f = fixture(); const prior = await f.host.captureProducerInventory();
  f.state.context = 'unix:///var/run/docker.sock';
  await assert.rejects(f.host.verifyProducerInventory(prior), code('RESEARCH_RECOVERY_DOCKER_HOST_CHANGED'));
  const expected = createResearchRecoveryHost({ ...options, dockerHost: 'unix:///var/run/docker.sock' }, {
    platform: 'darwin', run: async () => good(JSON.stringify('unix:///Users/operator/.docker/run/docker.sock')),
  });
  await assert.rejects(expected.captureProducerInventory(), code('RESEARCH_RECOVERY_DOCKER_HOST_CHANGED'));
});


test('known-service labels never exempt oneoffs, altered commands or overridden entrypoints', async () => {
  for (const service of ['llm-agent', 'execution-engine', 'ingestion', 'signal-engine', 'backtest-engine', 'ui']) {
    for (const change of [
      { oneoff: 'True' }, { oneoff: 'true' }, { oneoff: null },
      { cmd: ['pnpm', '--filter', '@ikbr/llm-agent', 'ops:research-recovery'] },
      { cmd: ['sh', '-c', 'pnpm --filter @ikbr/llm-agent start'] },
      { cmd: null }, { cmd: 'pnpm --filter @ikbr/llm-agent start' },
      { entrypoint: ['sh', '-c', 'pnpm --filter @ikbr/llm-agent start'] }, { entrypoint: null },
    ]) {
      const f = fixture(); const other = 'd'.repeat(64); f.state.ids.push(other);
      f.state.containers.set(other, { ...f.state.containers.get(id)!, service, ...change });
      await assert.rejects(f.host.captureProducerInventory(), code('RESEARCH_RECOVERY_PRODUCER_INVENTORY_UNSUPPORTED'));
    }
    if (service !== 'llm-agent') {
      const mislabeled = fixture(); const other = 'd'.repeat(64); mislabeled.state.ids.push(other);
      mislabeled.state.containers.set(other, { ...mislabeled.state.containers.get(id)!, service, cmd: ['pnpm', '--filter', '@ikbr/llm-agent', 'start'] });
      await assert.rejects(mislabeled.host.captureProducerInventory(), code('RESEARCH_RECOVERY_PRODUCER_INVENTORY_UNSUPPORTED'));
    }
  }
});

test('pinned image must use the supported unmodified image entrypoint', async () => {
  const f = fixture();
  f.state.override = (file, args) => file === 'docker' && args.includes('--type') && args.includes('image') ? good(JSON.stringify(['sh', '-c', 'worker'])) : undefined;
  await assert.rejects(f.host.captureProducerInventory(), code('RESEARCH_RECOVERY_PRODUCER_INVENTORY_UNSUPPORTED'));
});
