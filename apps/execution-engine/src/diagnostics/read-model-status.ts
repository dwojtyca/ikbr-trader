import type { DiagnosticCoverage, DiagnosticField, DiagnosticQuery, DiagnosticReport, DiagnosticScalar } from '@ikbr/shared/diagnostics';
import { evaluateResearchEligibility, researchHash, validateResearchManifest, type ResearchSnapshot } from '@ikbr/shared/instrument-research';
import { requireSessionSchedule, type SessionScheduleEvidence } from '@ikbr/shared';
import type { DiagnosticReadModelDeps } from './read-model.js';

type Row = Record<string, unknown>;
const record = (value: unknown): Row | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
const string = (value: unknown): string | null => typeof value === 'string' ? value : value === null || value === undefined ? null : String(value);
const iso = (value: unknown): string | null => value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() :
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const field = (key: string, label: string, value: DiagnosticScalar, sensitivity?: DiagnosticField['sensitivity']): DiagnosticField =>
  ({ key, label, value, ...(sensitivity ? { sensitivity } : {}) });
const coverage = (source: string, status: DiagnosticCoverage['status'], reason: string, observedAt: string | null = null): DiagnosticCoverage =>
  ({ source, status, observedAt, earliestAvailableAt: null, reasons: [reason] });

function set(fields: DiagnosticField[], replacement: DiagnosticField): void {
  const index = fields.findIndex(existing => existing.key === replacement.key);
  if (index < 0) fields.push(replacement);
  else fields[index] = replacement;
}

function ageMs(stamp: string | null, now: number): number | null {
  if (!stamp) return null;
  const delta = now - Date.parse(stamp);
  return delta >= 0 ? delta : null;
}

export async function appendDiagnosticStatus(deps: DiagnosticReadModelDeps, query: DiagnosticQuery, report: DiagnosticReport): Promise<void> {
  if (query.mode !== 'status') return;
  const accountId = deps.currentAccountId();
  if (!accountId) {
    report.coverage.push(coverage('account', 'UNAVAILABLE', 'ACCOUNT_ID_UNAVAILABLE'));
    return;
  }
  const sessionId = deps.currentSessionId();
  const now = Date.parse(report.generatedAt);
  const config = deps.configuration();
  const controls = deps.runtimeControls?.();
  const instruments = config.instruments.filter(item => !query.instrumentId || item.id === query.instrumentId);
  const completedSources = new Set<string>();
  const read = async (source: string, sql: string, params: unknown[]): Promise<Row[]> => {
    try {
      const result = await deps.pool.query(sql, params);
      completedSources.add(source);
      report.coverage.push(coverage(source, 'COMPLETE', 'BOUNDED_STORED_QUERY_ONLY', report.generatedAt));
      return result.rows as Row[];
    } catch {
      report.coverage.push(coverage(source, 'UNAVAILABLE', 'SOURCE_READ_FAILED'));
      return [];
    }
  };
  let watchlist: Row[] = [];
  if (deps.readWatchlist) {
    try {
      const response = record(await deps.readWatchlist());
      watchlist = response?.connected === true && Array.isArray(response.watchlist) ? response.watchlist.map(record).filter((row): row is Row => row !== null) : [];
      report.coverage.push(coverage('watchlist', response?.connected === true ? 'PARTIAL' : 'UNAVAILABLE',
        response?.connected === true ? 'READ_ONLY_QUOTE_NOT_ENTITLEMENT_PROOF' : 'WATCHLIST_UNAVAILABLE', report.generatedAt));
    } catch { report.coverage.push(coverage('watchlist', 'UNAVAILABLE', 'SOURCE_READ_FAILED')); }
  } else report.coverage.push(coverage('watchlist', 'UNAVAILABLE', 'SOURCE_NOT_CONFIGURED'));

  const [control, observer, reconciliation, holds, supervision, alerts, schedules, research] = await Promise.all([
    read('execution_entry_controls', 'SELECT paused,revision,updated_at FROM execution_entry_controls WHERE account_id=$1 LIMIT 1', [accountId]),
    read('lifecycle_observer_health', 'SELECT session_id,healthy,reason,observed_at FROM lifecycle_observer_health WHERE account_id=$1 LIMIT 1', [accountId]),
    read('reconciliation_runs', 'SELECT id,status,started_at,completed_at,snapshot_captured_at,snapshot_complete FROM reconciliation_runs WHERE account_id=$1 ORDER BY started_at DESC,id DESC LIMIT 1', [accountId]),
    read('reconciliation_holds', 'SELECT identity_key,reason,severity,created_at FROM reconciliation_holds WHERE account_id=$1 AND active=true ORDER BY created_at DESC,id DESC LIMIT 1001', [accountId]),
    read('lifecycle_supervision', 'SELECT instrument_id,conid,status,observed_at,exit_deadline,original_proposal_id,terminal_proof IS NOT NULL AS terminal_proof_recorded FROM lifecycle_supervision WHERE account_id=$1 AND instrument_id=ANY($2::text[]) ORDER BY observed_at DESC NULLS LAST,original_proposal_id DESC LIMIT 1001', [accountId, instruments.map(item => item.id)]),
    read('lifecycle_alert_outbox', 'SELECT status,created_at,delivered_at,last_error_code FROM lifecycle_alert_outbox WHERE account_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [accountId]),
    read('instrument_session_schedules', 'SELECT instrument_id,conid,use_rth,generation,status,evidence,updated_at FROM instrument_session_schedules WHERE instrument_id=ANY($1::text[]) ORDER BY instrument_id,conid,use_rth LIMIT 1001', [instruments.map(item => item.id)]),
    config.configHash ? read('research_current', `SELECT a.manifest_hash,m.canonical_json AS manifest_json,h.instrument_id,h.snapshot_id,
      s.snapshot_hash,s.canonical_json AS snapshot_json,s.stored_at
      FROM research_authority a JOIN research_manifests m ON m.manifest_hash=a.manifest_hash AND m.config_hash=a.config_hash
      LEFT JOIN research_snapshot_heads h ON h.config_hash=a.config_hash AND h.manifest_hash=a.manifest_hash
      LEFT JOIN research_snapshots s ON s.id=h.snapshot_id AND s.config_hash=h.config_hash AND s.manifest_hash=h.manifest_hash
      WHERE a.config_hash=$1 ORDER BY h.instrument_id LIMIT 1001`, [config.configHash]) : Promise.resolve([]),
  ]);
  for (const [source, rows] of [['reconciliation_holds', holds], ['lifecycle_supervision', supervision], ['instrument_session_schedules', schedules], ['research_current', research]] as const) {
    if (rows.length > 1000) {
      report.truncated = true; report.omissions.push(`${source}:ROW_LIMIT`);
      const sourceCoverage = [...report.coverage].reverse().find(entry => entry.source === source);
      if (sourceCoverage) { sourceCoverage.status = 'PARTIAL'; sourceCoverage.reasons = ['ROW_LIMIT']; }
    }
  }

  const history = new Map<string, Map<string, Row>>();
  for (const timeframe of ['1m', '5m', '1h', '4h', '1d', '1w'] as const) {
    const rows = await read(`candles_${timeframe}`, `SELECT conid,source,count(*)::int AS candles,max(ts) AS last_at
      FROM candles_${timeframe} WHERE conid=ANY($1::text[]) AND source IN ($2,$3)
      GROUP BY conid,source`, [instruments.map(item => item.conId).filter(Boolean), 'ibkr_session_rth_native_v1', 'ibkr_session_full_native_v1']);
    const byConid = new Map<string, Row>();
    for (const row of rows) if (string(row.conid) && string(row.source)) byConid.set(`${row.conid}:${row.source}`, row);
    history.set(timeframe, byConid);
  }

  for (const item of instruments) {
    const section = report.sections.find(entry => entry.id === `instrument:${item.id}`);
    if (!section) continue;
    const fields = section.fields;
    set(fields, field('tradingEnabled', 'Główny przełącznik zapisów', typeof controls?.tradingEnabled === 'boolean' ? controls.tradingEnabled : null));
    set(fields, field('startupEntriesPaused', 'Pauza wejść przy uruchomieniu', typeof controls?.entriesPaused === 'boolean' ? controls.entriesPaused : null));
    set(fields, field('lifecycleAutomationEnabled', 'Automatyzacja terminów wyjścia', typeof controls?.automationEnabled === 'boolean' ? controls.automationEnabled : null));
    set(fields, field('entryEnabled', 'Wejście dla instrumentu włączone', typeof item.entryEnabled === 'boolean' ? item.entryEnabled : null));
    set(fields, field('monitoringEnabled', 'Monitorowanie instrumentu włączone', typeof item.monitoringEnabled === 'boolean' ? item.monitoringEnabled : null));
    const instances = item.instances ?? [];
    if (instances.length > 80) { report.truncated = true; report.omissions.push(`instrument:${item.id}:INSTANCE_FIELD_LIMIT`); }
    for (const instance of instances.slice(0, 80)) set(fields, field(`instance:${instance.instanceId}:enabled`,
      `Instancja ${instance.implementationId}/${instance.instanceId} włączona`, typeof instance.enabled === 'boolean' ? instance.enabled : null));
    const matches = watchlist.filter(row => row.instrumentId === item.id && row.symbol === item.symbol && string(row.conid) === item.conId);
    const watch = matches.length === 1 && matches[0].subscribed === true ? matches[0] : null;
    const quote = watch && record(watch.marketState)?.conid === item.conId ? record(watch.marketState) : null;
    const bidAt = iso(quote?.bidObservedAt), askAt = iso(quote?.askObservedAt);
    const quoteAt = bidAt && askAt ? (bidAt < askAt ? bidAt : askAt) : bidAt ?? askAt;
    set(fields, field('watchlistSubscribed', 'Subskrypcja danych', matches.length === 1 ? matches[0].subscribed === true : null));
    set(fields, field('quoteType', 'Typ kwotowania IBKR', typeof quote?.marketDataType === 'number' ? quote.marketDataType : null));
    set(fields, field('bidObservedAt', 'Obserwacja bid', bidAt));
    set(fields, field('askObservedAt', 'Obserwacja ask', askAt));
    set(fields, field('bidAgeMs', 'Wiek bid ms', ageMs(bidAt, now)));
    set(fields, field('askAgeMs', 'Wiek ask ms', ageMs(askAt, now)));
    set(fields, field('quoteAgeMs', 'Wiek ostatniej obserwacji kwotowania ms', ageMs(quoteAt, now)));
    set(fields, field('quoteCurrent', 'Aktualne kwotowanie potwierdzone', null));

    const scheduleRows = schedules.filter(row => row.instrument_id === item.id && string(row.conid) === item.conId);
    for (const useRth of [true, false]) {
      const suffix = useRth ? 'Rth' : 'Full';
      const row = scheduleRows.find(candidate => candidate.use_rth === useRth);
      set(fields, field(`session${suffix}Status`, useRth ? 'Harmonogram RTH' : 'Harmonogram pełny', string(row?.status)));
      set(fields, field(`session${suffix}UpdatedAt`, useRth ? 'Aktualizacja harmonogramu RTH' : 'Aktualizacja harmonogramu pełnego', iso(row?.updated_at)));
      set(fields, field(`session${suffix}Generation`, useRth ? 'Generacja harmonogramu RTH' : 'Generacja harmonogramu pełnego', typeof row?.generation === 'number' ? row.generation : null));
      const evidence = record(row?.evidence);
      const configuredIdentity = item.sessionIdentity;
      const exact = row?.status === 'READY' && configuredIdentity?.instrumentId === item.id &&
        String(configuredIdentity.conId) === item.conId && configuredIdentity.useRTH === useRth;
      let valid = false;
      if (exact) {
        try {
          requireSessionSchedule({ generation: Number(row?.generation), status: 'READY', updatedAt: iso(row?.updated_at)!, schedule: evidence as unknown as SessionScheduleEvidence['schedule'] },
            configuredIdentity, now);
          valid = true;
        } catch { /* The stored schedule is not current or cannot be verified. */ }
      }
      set(fields, field(`session${suffix}Verified`, useRth ? 'Zweryfikowany harmonogram RTH' : 'Zweryfikowany harmonogram pełny', valid ? true : null));
    }
    const selectedSchedule = schedules.find(row => row.instrument_id === item.id && string(row.conid) === item.conId && row.use_rth === item.sessionIdentity?.useRTH);
    let sessionOpen: boolean | null = null;
    if (item.sessionIdentity && selectedSchedule?.status === 'READY') {
      try {
        const schedule = requireSessionSchedule({ generation: Number(selectedSchedule.generation), status: 'READY',
          updatedAt: iso(selectedSchedule.updated_at)!, schedule: record(selectedSchedule.evidence) as unknown as SessionScheduleEvidence['schedule'] },
          item.sessionIdentity, now);
        sessionOpen = schedule.sessions.some(slot => Date.parse(slot.start) <= now && now < Date.parse(slot.end));
      } catch { /* Unknown until verified session evidence is available. */ }
    }
    set(fields, field('sessionOpen', 'Sesja otwarta dla skonfigurowanego trybu', sessionOpen));

    for (const timeframe of history.keys()) {
      const rows = history.get(timeframe)!;
      for (const [mode, source] of [['RTH', 'ibkr_session_rth_native_v1'], ['FULL', 'ibkr_session_full_native_v1']] as const) {
        const row = rows.get(`${item.conId}:${source}`);
        set(fields, field(`candles${timeframe}${mode}`, `Świece ${timeframe} ${mode}, zapisane`, completedSources.has(`candles_${timeframe}`) ? typeof row?.candles === 'number' ? row.candles : 0 : null));
        set(fields, field(`lastCandle${timeframe}${mode}`, `Ostatnia świeca ${timeframe} ${mode}`, iso(row?.last_at)));
      }
    }

    const paused = control[0]?.paused;
    set(fields, field('entryPaused', 'Trwała pauza wejść', typeof paused === 'boolean' ? paused : null));
    set(fields, field('entryPauseUpdatedAt', 'Aktualizacja pauzy', iso(control[0]?.updated_at)));
    const health = observer[0];
    const healthSameSession = health?.session_id === sessionId;
    set(fields, field('observerHealthy', 'Stan obserwatora', healthSameSession && typeof health?.healthy === 'boolean' && ageMs(iso(health.observed_at), now) !== null && ageMs(iso(health.observed_at), now)! < 15_000 ? health.healthy : null));
    set(fields, field('observerObservedAt', 'Obserwacja nadzoru procesu', iso(health?.observed_at)));
    set(fields, field('observerReason', 'Powód obserwatora', healthSameSession ? string(health?.reason) : null, 'untrusted'));
    const run = reconciliation[0];
    set(fields, field('reconciliationStatus', 'Ostatnie uzgodnienie', string(run?.status)));
    set(fields, field('reconciliationCompletedAt', 'Zakończenie uzgodnienia', iso(run?.completed_at)));
    set(fields, field('reconciliationSnapshotComplete', 'Kompletność zapisanego snapshotu', typeof run?.snapshot_complete === 'boolean' ? run.snapshot_complete : null));
    set(fields, field('reconciliationCurrent', 'Bieżące uzgodnienie potwierdzone', null));
    const holdsComplete = completedSources.has('reconciliation_holds') && holds.length <= 1000;
    const instrumentKey = item.conId ? `conid:${accountId}|${item.conId}` : null;
    const ownHolds = instrumentKey ? holds.filter(row => row.identity_key === instrumentKey) : [];
    set(fields, field('activeHoldCount', 'Aktywne blokady instrumentu', holdsComplete && instrumentKey ? ownHolds.length : null));
    set(fields, field('activeHoldReasons', 'Powody blokad instrumentu', holdsComplete && ownHolds.length ? [...new Set(ownHolds.map(row => string(row.reason)).filter(Boolean))].join(', ') : null, 'untrusted'));
    set(fields, field('accountActiveHoldCount', 'Aktywne blokady konta', holdsComplete ? holds.length : null));
    set(fields, field('otherOrAmbiguousHoldCount', 'Inne lub niejednoznaczne blokady konta', holdsComplete && instrumentKey ? holds.length - ownHolds.length : null));
    const managed = supervision.find(row => row.instrument_id === item.id && string(row.conid) === item.conId);
    set(fields, field('supervisionStatus', 'Nadzór pozycji', string(managed?.status)));
    set(fields, field('supervisionObservedAt', 'Obserwacja nadzoru pozycji', iso(managed?.observed_at)));
    set(fields, field('exitDeadline', 'Termin wyjścia', iso(managed?.exit_deadline)));
    set(fields, field('protectionProofRecorded', 'Dowód terminalny', typeof managed?.terminal_proof_recorded === 'boolean' ? managed.terminal_proof_recorded : null));
    set(fields, field('alertDeliveryStatus', 'Ostatnia dostawa alertu konta', string(alerts[0]?.status)));
    set(fields, field('alertDeliveryAt', 'Czas dostawy alertu konta', iso(alerts[0]?.delivered_at)));

    const researchRow = research.find(row => row.instrument_id === item.id);
    set(fields, field('researchSnapshotId', 'Ostatni zapis badań', string(researchRow?.snapshot_id), 'identifier'));
    set(fields, field('researchStoredAt', 'Czas zapisu badań', iso(researchRow?.stored_at)));
    set(fields, field('researchCoverage', 'Pokrycie badań', null));
    if (researchRow && config.configHash) {
      try {
        const manifest = validateResearchManifest(JSON.parse(String(researchRow.manifest_json)));
        if (manifest.configHash !== config.configHash || researchHash(manifest) !== researchRow.manifest_hash) throw Error('MANIFEST_IDENTITY');
        const snapshot = JSON.parse(String(researchRow.snapshot_json)) as ResearchSnapshot;
        if (researchHash(snapshot) !== researchRow.snapshot_hash || snapshot.instrumentId !== item.id || snapshot.configHash !== config.configHash) throw Error('SNAPSHOT_IDENTITY');
        const eligibility = evaluateResearchEligibility(snapshot, manifest, now);
        set(fields, field('researchCoverage', 'Pokrycie badań', eligibility.eligible ? 'ELIGIBLE_AT_REPORT_TIME' : 'INELIGIBLE_AT_REPORT_TIME'));
        set(fields, field('researchBlockers', 'Blokady badań', eligibility.reasons.join(', ') || null));
        set(fields, field('researchExpiresAt', 'Ważność oceny badań do', eligibility.expiresAt));
        set(fields, field('calendarUse', 'Rola kalendarza', 'Kontekst decyzji AI; bez blokady wejść przed i po wydarzeniu'));
        set(fields, field('calendarEventCount', 'Wydarzenia w kontekście AI', snapshot.events.length));
        set(fields, field('newsNarrativeCount', 'Newsy z opisem lub fragmentem', snapshot.schemaVersion === 2 ? snapshot.news.filter(n => n.description || n.snippet).length : 0));
        set(fields, field('researchRequiredEvidenceRefs', 'Wymagane odsyłacze dowodów', eligibility.requiredEvidenceRefs.join(', ') || null, 'identifier'));
        for (const source of snapshot.coverage) {
          if (fields.length + 7 > 200) {
            report.truncated = true;
            report.omissions.push(`research:${item.id}:FIELD_LIMIT`);
            break;
          }
          const prefix = `research:${source.sourceId}:${source.role}`;
          set(fields, field(`${prefix}:status`, `Źródło ${source.sourceId}, ${source.role}`, source.status));
          set(fields, field(`${prefix}:checkedAt`, `Sprawdzenie ${source.sourceId}, ${source.role}`, source.checkedAt));
          set(fields, field(`${prefix}:ageMs`, `Wiek źródła ${source.sourceId}, ${source.role} ms`, ageMs(source.checkedAt, now)));
          set(fields, field(`${prefix}:complete`, `Kompletność źródła ${source.sourceId}, ${source.role}`, source.complete));
          set(fields, field(`${prefix}:refs`, `Odsyłacze źródła ${source.sourceId}, ${source.role}`, source.evidenceRefs.join(', ') || null, 'identifier'));
        }
      } catch {
        report.coverage.push(coverage(`research:${item.id}`, 'UNAVAILABLE', 'RESEARCH_STORED_EVIDENCE_INVALID'));
      }
    }
    set(fields, field('brokerStatus', 'Stan brokera', null));
    set(fields, field('accountingCompleteness', 'Kompletność P&L', null));
    if (fields.length > 200) {
      fields.length = 200;
      report.truncated = true;
      report.omissions.push(`instrument:${item.id}:FIELD_LIMIT`);
    }
  }
  const lifecycleRows = supervision.filter(row => instruments.some(item => item.id === row.instrument_id));
  if (lifecycleRows.length > 20) {
    report.truncated = true;
    report.omissions.push('lifecycle_supervision:STATUS_LIFECYCLE_LIMIT');
    const sourceCoverage = [...report.coverage].reverse().find(entry => entry.source === 'lifecycle_supervision');
    if (sourceCoverage?.status === 'COMPLETE') { sourceCoverage.status = 'PARTIAL'; sourceCoverage.reasons = ['STATUS_LIFECYCLE_LIMIT']; }
  }
  for (const row of lifecycleRows.slice(0, 20)) {
    const proposalId = Number(row.original_proposal_id);
    const identity = instruments.find(item => item.id === row.instrument_id);
    const lifecycleFields: DiagnosticField[] = [
      field('proposalId', 'Pierwotna propozycja', Number.isSafeInteger(proposalId) && proposalId > 0 ? String(proposalId) : null, 'identifier'),
      field('conId', 'Kontrakt cyklu', string(row.conid), 'identifier'),
      field('matchesCurrentContract', 'Kontrakt zgodny z bieżącą konfiguracją', identity?.conId && row.conid ? identity.conId === string(row.conid) : null),
      field('supervisionStatus', 'Zapisany stan nadzoru', string(row.status)),
      field('supervisionObservedAt', 'Ostatnia obserwacja nadzoru', iso(row.observed_at)),
      field('exitDeadline', 'Termin wyjścia', iso(row.exit_deadline)),
      field('roundTripStatus', 'Stan cyklu według oceny dowodów', null),
      field('roundTripReasons', 'Powody oceny cyklu', null, 'untrusted'),
      field('accounting', 'Kompletność rozliczenia', null),
      field('quoteCurrency', 'Waluta kontraktu', null),
      field('grossPnl', 'Wynik brutto', null, 'financial'),
      field('grossCurrency', 'Waluta wyniku brutto', null),
      field('netPnl', 'Wynik netto', null, 'financial'),
      field('netCurrency', 'Waluta wyniku netto', null),
      field('missingFeeCount', 'Brakujące prowizje', null),
    ];
    if (deps.roundTrip && Number.isSafeInteger(proposalId) && proposalId > 0) {
      try {
        const evaluated = await deps.roundTrip(proposalId);
        if (evaluated && evaluated.accountId === accountId && evaluated.proposalId === proposalId &&
          evaluated.instrumentId === row.instrument_id && evaluated.conid === string(row.conid)) {
          set(lifecycleFields, field('roundTripStatus', 'Stan cyklu według oceny dowodów', evaluated.status));
          set(lifecycleFields, field('roundTripReasons', 'Powody oceny cyklu', evaluated.reasons.join(', ') || null, 'untrusted'));
          set(lifecycleFields, field('accounting', 'Kompletność rozliczenia', evaluated.accounting));
          set(lifecycleFields, field('quoteCurrency', 'Waluta kontraktu', evaluated.quoteCurrency));
          set(lifecycleFields, field('grossPnl', 'Wynik brutto', evaluated.grossPnl?.amount ?? null, 'financial'));
          set(lifecycleFields, field('grossCurrency', 'Waluta wyniku brutto', evaluated.grossPnl?.currency ?? null));
          set(lifecycleFields, field('netPnl', 'Wynik netto', evaluated.netPnl?.amount ?? null, 'financial'));
          set(lifecycleFields, field('netCurrency', 'Waluta wyniku netto', evaluated.netPnl?.currency ?? null));
          set(lifecycleFields, field('missingFeeCount', 'Brakujące prowizje', evaluated.missingCommissionExecIds.length));
        } else report.coverage.push(coverage(`round_trip:${proposalId}`, 'UNAVAILABLE', evaluated ? 'ROUND_TRIP_IDENTITY_MISMATCH' : 'ROUND_TRIP_EVIDENCE_MISSING'));
      } catch { report.coverage.push(coverage(`round_trip:${proposalId}`, 'UNAVAILABLE', 'SOURCE_READ_FAILED')); }
    } else report.coverage.push(coverage(`round_trip:${Number.isSafeInteger(proposalId) ? proposalId : 'invalid'}`, 'UNAVAILABLE',
      deps.roundTrip ? 'PROPOSAL_ID_INVALID' : 'SOURCE_NOT_CONFIGURED'));
    report.sections.push({ id: `lifecycle:${row.original_proposal_id}`, title: 'Cykl nadzorowanej pozycji',
      instrumentId: string(row.instrument_id), fields: lifecycleFields });
  }
  if (deps.currentAccountId() !== accountId || deps.currentSessionId() !== sessionId) {
    report.sections = report.sections.filter(section => !section.id.startsWith('instrument:') && !section.id.startsWith('lifecycle:'));
    report.coverage.push(coverage('account', 'UNAVAILABLE', 'ACCOUNT_CONTEXT_CHANGED'));
    report.omissions.push('ACCOUNT_CONTEXT_CHANGED');
  }
}
