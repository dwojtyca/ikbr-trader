import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { z } from 'zod';
import { loadTradingConfiguration } from '@ikbr/shared/trading-config';
import { loadResearchManifest, parseRecoveryEvidence, parseRecoveryIdentity, researchHash, ResearchStore,
  type RecoveryChallenge, type RecoveryIdentity, type RecoveryCommit, type RecoverySupersede,
  type RecoveryEvidence, type RecoveryQuiescenceEvidence, type WshRecoveryEvidence } from '@ikbr/shared/instrument-research';
import { loadWshRuntimeConfiguration, WshSocketTransport, type WshTransport } from './research-wsh-transport.js';

const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const selection = { kind: z.enum(['MARKETAUX_PRODUCER_QUIESCENCE', 'WSH_ENDPOINT_RESET']), instrumentId: z.string().min(1).max(200), operationId: uuid };
const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('prepare'), ...selection }).strict(),
  z.object({ action: z.literal('read'), challengeId: uuid }).strict(),
  z.object({ action: z.literal('receipt'), challengeId: uuid, operationId: uuid }).strict(),
  z.object({ action: z.literal('replacement'), ...selection }).strict(),
  z.object({ action: z.literal('reconnect'), challengeId: uuid, challengeHash: hash }).strict(),
  z.object({ action: z.literal('commit'), challengeId: uuid, challengeHash: hash, operationId: uuid, evidence: z.unknown() }).strict(),
  z.object({ action: z.literal('supersede'), challengeId: uuid, challengeHash: hash, ...selection, evidence: z.unknown() }).strict(),
]);
type RecoveryMethods = Pick<ResearchStore, 'prepareResearchRecovery' | 'readResearchRecovery' | 'readResearchRecoveryReplacement' | 'readResearchRecoveryReceipt' | 'commitResearchRecovery' | 'supersedeResearchRecovery'>;
type Context = { accountId: string; actor: string; revision: number; processId: string; configHash: string; manifestHash: string };
function requireRecovery(condition: unknown, code = 'RESEARCH_RECOVERY_PREFLIGHT_DENIED'): asserts condition { if (!condition) throw new Error(code); }
const obj = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;

export async function recoveryAuthenticatedRead(env: NodeJS.ProcessEnv, path: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  requireRecovery(['/execution/configuration', '/execution/entry-control'].includes(path));
  const base = new URL(env.LLM_AGENT_EXECUTION_BASE_URL ?? 'http://execution-engine:3103');
  requireRecovery(base.protocol === 'http:' && ['execution-engine', 'localhost', '127.0.0.1'].includes(base.hostname)
    && base.port === '3103' && base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash);
  requireRecovery(typeof env.EXECUTION_API_TOKEN === 'string' && env.EXECUTION_API_TOKEN.length > 0);
  const response = await fetchImpl(new URL(path, base), { redirect: 'error', signal: AbortSignal.timeout(3000), headers: { Authorization: `Bearer ${env.EXECUTION_API_TOKEN}` } });
  requireRecovery(response.ok && response.body);
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 131072) { await reader.cancel(); throw new Error('RESEARCH_RECOVERY_PREFLIGHT_DENIED'); } chunks.push(part.value); } }
  finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export async function executeResearchRecovery(request: unknown, env: NodeJS.ProcessEnv, deps: {
  store: RecoveryMethods; read?: (path: string) => Promise<unknown>;
  transport?: (configuration: ReturnType<typeof loadWshRuntimeConfiguration> & { accountId: string }) => Pick<WshTransport, 'connect' | 'close' | 'sessionId' | 'serverVersion' | 'sdkVersion'>;
  now?: () => number; readFile?: (path: string) => string;
}): Promise<unknown> {
  requireRecovery(Buffer.byteLength(JSON.stringify(request)) <= 65536, 'RESEARCH_RECOVERY_REQUEST_INVALID');
  const command = requestSchema.parse(request);
  const loaded = loadTradingConfiguration(env, { readFile: deps.readFile });
  requireRecovery(loaded.mode === 'bundle' && env.IBKR_ENVIRONMENT === 'paper' && !env.ALLOWED_LIVE_ACCOUNTS);
  const accountId = env.RESEARCH_BUDGET_ACCOUNT_ID;
  const accounts = env.ALLOWED_PAPER_ACCOUNTS?.split(',').map(x => x.trim()).filter(Boolean);
  requireRecovery(accountId && /^[A-Za-z0-9_-]{1,80}$/.test(accountId) && accounts?.length === 1 && accounts[0] === accountId && (!env.IBKR_ACCOUNT_ID || env.IBKR_ACCOUNT_ID === accountId));
  requireRecovery(env.EXECUTION_API_TOKEN);
  const research = loadResearchManifest(env, loaded);
  requireRecovery(research);
  const actor = `operator:${createHash('sha256').update(env.EXECUTION_API_TOKEN).digest('hex')}`;
  const read = deps.read ?? (path => recoveryAuthenticatedRead(env, path));
  const preflight = async (): Promise<Context> => {
    const configuration = obj(await read('/execution/configuration'));
    const result = obj(await read('/execution/entry-control')), control = obj(result?.control);
    requireRecovery(configuration?.initialized === true && configuration.mode === 'bundle' && configuration.effectiveHash === loaded.effectiveHash
      && typeof configuration.processId === 'string' && configuration.processId.length > 0 && result?.startupProtocolVersion === 1
      && control?.account_id === accountId && control.paused === true && Number.isSafeInteger(Number(control.revision)) && Number(control.revision) > 0);
    return { accountId, actor, revision: Number(control.revision), processId: configuration.processId, configHash: loaded.effectiveHash, manifestHash: research.hash };
  };
  const current = await preflight();
  const identity = (input: z.infer<typeof requestSchema> & { kind: RecoveryIdentity['kind']; instrumentId: string; operationId: string }): RecoveryIdentity => {
    const policy = research.manifest.instruments.find(x => x.instrumentId === input.instrumentId);
    const sources = policy?.sources.filter(x => x.adapter === (input.kind === 'WSH_ENDPOINT_RESET' ? 'ibkr-wsh' : 'marketaux-news'));
    requireRecovery(sources?.length === 1);
    return parseRecoveryIdentity({ kind: input.kind, instrumentId: input.instrumentId, sourceId: sources[0].id, operationId: input.operationId,
      configHash: current.configHash, manifestHash: current.manifestHash, accountId, actor, pauseRevision: current.revision });
  };
  const checkedChallenge = async (id: string, expectedHash?: string): Promise<RecoveryChallenge> => {
    const challenge = await deps.store.readResearchRecovery(id);
    requireRecovery(challenge && challenge.accountId === accountId && challenge.configHash === current.configHash && challenge.manifestHash === current.manifestHash
      && challenge.pauseRevision === current.revision && challenge.executionProcessId === current.processId && (!expectedHash || challenge.challengeHash === expectedHash));
    return challenge;
  };
  if (command.action === 'prepare') return deps.store.prepareResearchRecovery(identity(command));
  if (command.action === 'replacement') return deps.store.readResearchRecoveryReplacement(command.operationId, identity(command));
  if (command.action === 'read') return checkedChallenge(command.challengeId);
  if (command.action === 'receipt') { await checkedChallenge(command.challengeId); return deps.store.readResearchRecoveryReceipt(command.challengeId, command.operationId); }
  if (command.action === 'supersede') {
    const evidence = parseRecoveryEvidence(command.evidence, true);
    requireRecovery(evidence.kind === 'PRODUCER_QUIESCENCE');
    const input: RecoverySupersede = { challengeId: command.challengeId, challengeHash: command.challengeHash, replacement: identity(command), evidence: evidence as RecoveryQuiescenceEvidence };
    return deps.store.supersedeResearchRecovery(input);
  }
  const challenge = await checkedChallenge(command.challengeId, command.challengeHash);
  const settings = loadWshRuntimeConfiguration(env);
  const validateEndpoint = (evidence: WshRecoveryEvidence) => requireRecovery(settings.enabled && challenge.endpointId === settings.endpointId
    && evidence.endpointId === settings.endpointId && evidence.host === settings.host && evidence.port === settings.port && evidence.clientId === settings.clientId
    && evidence.endpointSettingsHash === researchHash({ endpointId: settings.endpointId, host: settings.host, port: settings.port, clientId: settings.clientId })
    && evidence.reconnect.accountId === accountId);
  if (command.action === 'commit') {
    const evidence = parseRecoveryEvidence(command.evidence);
    requireRecovery(evidence.kind === challenge.kind);
    if (evidence.kind === 'WSH_ENDPOINT_RESET') validateEndpoint(evidence);
    const input: RecoveryCommit = { challengeId: challenge.id, challengeHash: challenge.challengeHash, operationId: command.operationId, actor,
      pauseRevision: current.revision, evidence: evidence as RecoveryEvidence };
    return deps.store.commitResearchRecovery(input);
  }
  requireRecovery(command.action === 'reconnect' && challenge.state === 'PREPARED' && challenge.kind === 'WSH_ENDPOINT_RESET'
    && settings.enabled && challenge.endpointId === settings.endpointId && ['host.docker.internal', 'localhost', '127.0.0.1', '::1'].includes(settings.host));
  const now = deps.now ?? Date.now, started = now();
  const transport = (deps.transport ?? (configuration => new WshSocketTransport({ ...configuration, secrets: [env.EXECUTION_API_TOKEN!] })) )({ ...settings, accountId });
  let completed: number; let cleanup: Awaited<ReturnType<WshTransport['close']>>;
  try { await transport.connect(new Date(started + 10000).toISOString()); completed = now(); }
  finally { cleanup = await transport.close(); }
  requireRecovery(Number.isFinite(completed!) && completed! >= started && completed! - started <= 10000
    && transport.sdkVersion === '1.6.10' && transport.serverVersion >= 173 && cleanup.state === 'CONFIRMED'
    && cleanup.verifiedLocalClosure && cleanup.sessionId === transport.sessionId && !cleanup.sourceError
    && cleanup.localClosedAt !== null && cleanup.disconnectRequestedAt !== null && Date.parse(cleanup.completedAt) >= completed!);
  const after = await preflight();
  requireRecovery(after.processId === current.processId && after.revision === current.revision);
  await checkedChallenge(challenge.id, challenge.challengeHash);
  return { startedAt: new Date(started).toISOString(), completedAt: new Date(completed!).toISOString(), sessionId: transport.sessionId,
    accountId, serverVersion: transport.serverVersion, sdkVersion: '1.6.10', cleanup };
}

export async function runResearchRecoveryCli(input: AsyncIterable<Uint8Array> = process.stdin, env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  let bytes = 0; const chunks: Uint8Array[] = [];
  for await (const chunk of input) { bytes += chunk.length; requireRecovery(bytes <= 65536, 'RESEARCH_RECOVERY_REQUEST_INVALID'); chunks.push(chunk); }
  requireRecovery(env.POSTGRES_URL, 'RESEARCH_RECOVERY_DATABASE_REQUIRED');
  const pool = new Pool({ connectionString: env.POSTGRES_URL, max: 1, connectionTimeoutMillis: 3000, query_timeout: 3000, statement_timeout: 3000 });
  try { return await executeResearchRecovery(JSON.parse(Buffer.concat(chunks).toString('utf8')), env, { store: new ResearchStore(pool) }); }
  finally { await pool.end(); }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void runResearchRecoveryCli().then(result => process.stdout.write(JSON.stringify({ ok: true, result }) + '\n')).catch(() => {
    process.stdout.write(JSON.stringify({ ok: false, reason: 'RESEARCH_RECOVERY_FAILED_OR_UNKNOWN' }) + '\n'); process.exitCode = 1;
  });
}
