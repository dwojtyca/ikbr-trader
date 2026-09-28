import { readFileSync } from 'node:fs';
import { computeTradingConfigurationHash, loadTradingConfiguration, parseTradingConfiguration } from '@ikbr/shared/trading-config';
import { parsePaperRunPolicy } from './paper-run-policy.js';
export function paperPolicyFixture(startsAt='2026-09-28T14:00:00Z', endsAt='2026-09-28T14:30:00Z') {
  const raw = JSON.parse(readFileSync(new URL('../../../packages/shared/src/trading-configuration/fixtures/valid-generic.json', import.meta.url), 'utf8'));
  const parsed = parseTradingConfiguration(raw);
  if (!parsed.ok) throw new Error('invalid fixture');
  const loaded = loadTradingConfiguration({ TRADING_CONFIG_MODE: 'bundle', TRADING_CONFIG_PATH: '/fixture.json', TRADING_CONFIG_EXPECTED_HASH: computeTradingConfigurationHash(parsed.configuration) }, { readFile: () => JSON.stringify(raw) });
  if (loaded.mode !== 'bundle') throw new Error('fixture mode');
  const manifest = { version: 1, runId: 'pp3_test', accountId: 'DU_PP3_FIXTURE', effectiveConfigHash: loaded.effectiveHash,
    accountDayTimeZone: 'Europe/Warsaw', kind: 'supervised_one_attempt', maxAttemptsPerAccountDay: 1, maxAttemptsPerInstrumentDay: 1,
    windows: loaded.configuration.instruments.slice(0, 3).map(i => ({ instrumentId: i.id, conId: i.contract.conId, startsAt, endsAt })),
    currencyCaps: { PLN: { maxNotional: 1000, maxStopRisk: 10, feeReserve: 5, maxDailyLoss: 20 }, USD: { maxNotional: 1000, maxStopRisk: 10, feeReserve: 5, maxDailyLoss: 20 } } };
  const env = { IBKR_ENVIRONMENT: 'paper', PAPER_RUN_POLICY_JSON: JSON.stringify(manifest) };
  return { manifest, env, loaded, policy: parsePaperRunPolicy(env, loaded)! };
}
