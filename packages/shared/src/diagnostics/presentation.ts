import type { DiagnosticEvent, DiagnosticReport } from './types.js';

export interface PresentationOptions { timeZone?: string }
export interface CompactedDiagnosticEvent extends DiagnosticEvent {
  /** Number of equivalent adjacent events represented by this row. */
  count: number;
  firstOccurredAt: string;
  lastOccurredAt: string;
  sourceEventIds: string[];
  evaluationIds: string[];
  auditRefs: string[];
}
export interface CompactedDiagnosticEvents {
  events: Array<DiagnosticEvent | CompactedDiagnosticEvent>;
  /** IDs of conflicting duplicate versions retained explicitly in `events`. */
  duplicateConflicts: string[];
}

const reasons: Record<string, { message: string; impact: string; action: string }> = {
  PROPOSAL_RECORDED: { message: 'Zapisano propozycję.', impact: 'Sam zapis nie oznacza decyzji AI ani wysłania zlecenia.', action: 'Sprawdź historię propozycji przez trace.' },
  NO_SIGNAL: { message: 'Strategia nie wygenerowała sygnału.', impact: 'Nie powstała propozycja wejścia.', action: 'Sprawdź kolejną zaplanowaną ocenę.' },
  STRATEGY_NO_SIGNAL: { message: 'Strategia nie wygenerowała sygnału.', impact: 'Nie powstała propozycja wejścia.', action: 'Sprawdź kolejną zaplanowaną ocenę.' },
  REJECTED: { message: 'Propozycja została odrzucona.', impact: 'Ta propozycja nie przechodzi dalej.', action: 'Sprawdź zapisane powody decyzji.' },
  AI_REJECT: { message: 'Decyzja AI: odrzuć.', impact: 'Propozycja nie została dopuszczona.', action: 'Sprawdź zapisaną decyzję i jej uzasadnienie.' },
  ENTRY_PAUSED: { message: 'Wejścia są wstrzymane.', impact: 'Nowe wejścia nie są dopuszczane.', action: 'Sprawdź przyczynę i stan trwałej pauzy.' },
  MARKET_CLOSED: { message: 'Rynek jest zamknięty.', impact: 'Ocena nie może teraz doprowadzić do wejścia.', action: 'Sprawdź następne okno sesji.' },
  STALE_DATA: { message: 'Dane są nieaktualne.', impact: 'Ocena opiera się na nieświeżych danych.', action: 'Sprawdź źródło danych i czas ostatniej obserwacji.' },
  RESEARCH_REQUIRED_STALE: { message: 'Wymagane dane badawcze są nieaktualne.', impact: 'Wymagany warunek badawczy nie jest spełniony.', action: 'Sprawdź status źródła i czas ostatniej obserwacji.' },
  SUBMISSION_UNKNOWN: { message: 'Wynik wysłania zlecenia jest nieznany.', impact: 'Nie można potwierdzić wyniku operacji.', action: 'Sprawdź stan brokera i uzgodnienie; nie ponawiaj wysłania.' },
  SUBMITTED: { message: 'Zlecenie wysłano.', impact: 'Wysłanie nie potwierdza realizacji.', action: 'Sprawdź potwierdzenie i status realizacji u brokera.' },
  FILLED: { message: 'Zlecenie zostało zrealizowane.', impact: 'Zapis wskazuje realizację zlecenia.', action: 'Sprawdź ochronę pozycji i powiązane zapisy.' },
  ERROR: { message: 'Wystąpił błąd.', impact: 'Operacja wymaga sprawdzenia.', action: 'Sprawdź szczegóły zdarzenia i źródło.' },
};

const explanations: Array<[string[], string, string, string]> = [
  [['NO_STRATEGY_SIGNAL'], 'Strategia nie wygenerowała sygnału.', 'Brak propozycji wejścia.', 'Poczekaj na kolejną ocenę.'],
  [['ENTRY_DISABLED','EXECUTION_ENTRIES_PAUSED','ENTRY_PAUSED','paper_trading_disabled','LOOP_DISABLED'], 'Nowe wejścia są wyłączone lub wstrzymane.', 'Ten stan nie zatrzymuje już wysłanych zleceń ani obsługiwanych automatycznych wyjść.', 'Sprawdź master, pauzę startową i trwałą pauzę.'],
  [['STRATEGY_INSTANCE_DISABLED','STRATEGY_SAFETY_DISABLED'], 'Przypisana strategia jest wyłączona lub w okresie blokady.', 'Nie powstaje nowe wejście tej strategii.', 'Sprawdź przypisanie i zapisaną przyczynę blokady.'],
  [['PP4_RESEARCH_UNAVAILABLE','RESEARCH_REQUIRED_COVERAGE_UNAVAILABLE','RESEARCH_UNAVAILABLE'], 'Brakuje wymaganych, potwierdzonych badań.', 'Warunki wejścia nie zostały spełnione.', 'Sprawdź pokrycie i wiek zapisanych źródeł; raport nie odblokowuje wejścia.'],
  [['CONFIG_DRIFT','CONFIG_SERVICE_UNAVAILABLE'], 'Usługi nie potwierdzają wspólnej aktualnej konfiguracji.', 'Ocena lub wejście mogą być blokowane.', 'Porównaj hash konfiguracji i obserwacje usług.'],
  [['STRATEGY_CONTEXT_UNAVAILABLE','STALE_PRICE','BROKER_STATE_STALE','RECONCILIATION_STALE'], 'Wymagane dane lub stan brokera są nieaktualne.', 'Nie można potwierdzić bezpiecznego dalszego działania.', 'Sprawdź czasy źródeł i aktualne uzgodnienie.'],
  [['UNKNOWN','CANCEL_UNKNOWN','BROKER_UNAVAILABLE','RECONCILIATION_UNAVAILABLE'], 'Stan lub wynik operacji brokera jest nieznany.', 'Pozostaje niepewność; nie ma dowodu anulowania ani zamknięcia.', 'Nie ponawiaj operacji. Sprawdź zapisany identyfikator i obsługiwane uzgodnienie.'],
  [['HOLD','BLOCKED','RECONCILIATION_HOLD','CLOSE_BLOCKED'], 'Operacja pozostaje zablokowana.', 'Wymagane jest wyjaśnienie przyczyny; blokada nie jest usuwana przez raport.', 'Sprawdź dowody brokera, własność i istniejącą operację zamknięcia.'],
  [['AI_EXECUTE','APPROVED'], 'AI zaakceptowała zapisaną propozycję.', 'To nie potwierdza dopuszczenia przez ryzyko ani realizacji zlecenia.', 'Sprawdź świeże ryzyko i dalszy audyt wykonania.'],
  [['AI_EXPIRED','EXPIRED'], 'Termin oceny AI upłynął.', 'Brak ważnej decyzji dla tego wejścia.', 'Sprawdź czas wywołania i zapisany wynik; nie fabrykuj ponownej zgody.'],
  [['PENDING','AWAITING_AI'], 'Propozycja oczekuje na dalszą ocenę.', 'Nie ma jeszcze potwierdzonego wykonania.', 'Sprawdź zapisany termin i historię propozycji.'],
  [['PREPARING'], 'Trwa przygotowanie obsługi zamknięcia.', 'Może trwać koordynacja istniejących zleceń ochronnych.', 'Obserwuj ten sam identyfikator; nie wykonuj równoległej sprzedaży.'],
  [['COMPLETED'], 'Zapisany etap cyklu został zakończony.', 'Kompletność rozliczenia i bieżący stan brokera są osobnymi dowodami.', 'Sprawdź wynik ewaluatora, brakujące prowizje i outstanding orders.'],
  [['FAULT_RESOLVED','HOLD_RESOLVED'], 'Zapisano rozwiązanie epizodu błędu.', 'Nie jest to ogólne potwierdzenie gotowości całego konta.', 'Sprawdź pozostałe blokady i aktualne źródła.'],
  [['PROTECTION_GAP','PROTECTION_UNKNOWN','ORPHAN_OWNERSHIP','FOREIGN_ORDER_CONFLICT'], 'Ochrona lub przypisanie pozycji wymagają reakcji.', 'Nie można uznać zarządzania pozycją za potwierdzone.', 'Sprawdź nadzór PP5 i brokera; nie kasuj holdów ani nie sprzedawaj ponownie.'],
  [['DELIVERED'], 'Dostawca potwierdził przyjęcie alertu.', 'Nie oznacza to przeczytania ani rozwiązania incydentu.', 'Sprawdź stan epizodu i potrzebną reakcję.'],
  [['FAILED','DISABLED'], 'Dany etap jest niedostępny lub wyłączony.', 'Wymagana funkcja nie jest potwierdzona.', 'Sprawdź usługę i zapisany powód.'],
  [['CONFIGURED_EVALUATION'], 'Zapisano ocenę przypisanej strategii.', 'Ocena nie jest uprawnieniem do wysłania zlecenia.', 'Sprawdź wynik oceny i wszystkie blokady wejścia.'],
  [['SKIPPED','NOT_SUBMITTED','NO_TRADE'], 'Nie wysłano nowego wejścia.', 'Sprawdź powód oceny lub blokady; nie zakładaj braku sygnału.', 'Otwórz historię tej oceny.'],
];
for (const [codes, message, impact, action] of explanations) for (const code of codes) reasons[code]={message,impact,action};

function safe(value: unknown): string {
  return String(value ?? '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u001b\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function describeDiagnosticReason(reason: string): { message: string; impact: string; action: string } {
  const key = safe(reason);
  return reasons[key] ?? {
    message: `Nieznany powód: ${key || '(brak kodu)'}.`,
    impact: 'Znaczenie kodu nie zostało rozpoznane; nie można wyciągnąć wniosku o stanie.',
    action: 'Sprawdź kod w źródłowym zdarzeniu lub dokumentacji usługi.',
  };
}

function date(value: string, zone: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return `${safe(value)} (czas nieprawidłowy)`;
  const parts = new Intl.DateTimeFormat('pl-PL', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
  }).formatToParts(parsed);
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} ${get('timeZoneName').replace('GMT', 'UTC')}`;
}

function fieldLines(fields: DiagnosticEvent['fields']): string[] {
  return fields.map(field => `  ${safe(field.label || field.key)}: ${field.value === null ? 'brak danych' : safe(field.value)}`);
}

function polishSeverity(severity: DiagnosticEvent['severity']): string {
  return ({ INFO: 'informacja', WARN: 'ostrzeżenie', ERROR: 'błąd', CRITICAL: 'krytyczne' })[severity];
}

function polishCoverage(status: DiagnosticReport['coverage'][number]['status']): string {
  return ({ COMPLETE: 'pełne w podanym zakresie', PARTIAL: 'częściowe', UNAVAILABLE: 'niedostępne' })[status];
}

function polishMode(mode: DiagnosticReport['mode']): string {
  return ({ events: 'zdarzenia', status: 'stan', timeline: 'oś czasu', session: 'sesja' })[mode];
}

export function formatDiagnosticEvent(event: DiagnosticEvent, options: PresentationOptions = {}): string {
  const zone = options.timeZone ?? 'Europe/Warsaw';
  const symbol = event.symbol ? safe(event.symbol) : event.instrumentId ? safe(event.instrumentId) : 'brak instrumentu';
  const listing = event.listing ? `/${safe(event.listing)}` : '';
  const described = describeDiagnosticReason(event.reason);
  const message = event.message ? safe(event.message) : described.message;
  const impact = event.impact ? safe(event.impact) : described.impact;
  const action = event.action ? safe(event.action) : described.action;
  const identities: Array<[string, unknown]> = [
    ['conId', event.conId], ['strategia', event.implementationId], ['instancja', event.instanceId],
    ['rewizja', event.revision], ['config', event.configHash], ['ocena', event.evaluationId], ['ślad', event.traceId],
    ['propozycja', event.proposalId], ['zlecenie brokera', event.brokerOrderId], ['cykl', event.lifecycleId],
    ['zamknięcie', event.closeId], ['snapshot badań', event.researchSnapshotId], ['audyt', event.auditRef],
  ].filter((entry): entry is [string, string | number] => entry[1] !== null && entry[1] !== undefined && entry[1] !== '');
  const lines = [`${date(event.occurredAt, zone)} | ${symbol}${listing} | ${polishSeverity(event.severity)} (${safe(event.severity)}) | ${message}`,
    `Powód: ${safe(event.reason)} | wpływ: ${impact} | działanie: ${action}`,
    `Zdarzenie: ${safe(event.id)} | kod: ${safe(event.code)} | usługa: ${safe(event.service)} | zapisano: ${date(event.recordedAt, zone)}`];
  if (identities.length) lines.push(`Identyfikatory: ${identities.map(([label, value]) => `${label}=${safe(value)}`).join(', ')}`);
  if ('count' in event && typeof event.count === 'number' && event.count > 1) {
    const compacted = event as CompactedDiagnosticEvent;
    lines.push(`Powtórzenia: ${compacted.count} | pierwsze: ${date(compacted.firstOccurredAt, zone)} | ostatnie: ${date(compacted.lastOccurredAt, zone)}`);
    lines.push(`Zdarzenia źródłowe: ${compacted.sourceEventIds.map(safe).join(', ')}`);
    if (compacted.evaluationIds.length) lines.push(`Oceny źródłowe: ${compacted.evaluationIds.map(safe).join(', ')}`);
    if (compacted.auditRefs.length) lines.push(`Odsyłacze audytu: ${compacted.auditRefs.map(safe).join(', ')}`);
  }
  lines.push(...fieldLines(event.fields));
  return lines.join('\n');
}

export function formatDiagnosticReport(report: DiagnosticReport, options: PresentationOptions = {}): string {
  const zone = options.timeZone ?? 'Europe/Warsaw';
  const lines = [`Raport diagnostyczny | tryb: ${polishMode(report.mode)} (${safe(report.mode)}) | wygenerowano: ${date(report.generatedAt, zone)}`,
    `Zakres UTC: ${safe(report.interval.from)} — ${safe(report.interval.to)}`, '', 'Pokrycie danych:'];
  if (!report.coverage.length) lines.push('  brak danych o pokryciu');
  for (const coverage of report.coverage) {
    lines.push(`  ${safe(coverage.source)}: ${polishCoverage(coverage.status)} (${safe(coverage.status)}) | obserwowano: ${coverage.observedAt ? date(coverage.observedAt, zone) : 'brak danych'} | najstarszy zapis: ${coverage.earliestAvailableAt ? date(coverage.earliestAvailableAt, zone) : 'brak danych'}`);
    for (const reason of coverage.reasons) lines.push(`    powód: ${safe(reason)}`);
  }
  lines.push('', 'Liczniki:');
  if (!report.counters.length) lines.push('  brak danych');
  for (const counter of report.counters) lines.push(`  ${safe(counter.label || counter.key)}: ${counter.value === null ? 'brak danych' : safe(counter.value)}`);
  for (const section of report.sections) {
    lines.push('', `${safe(section.title)} [${safe(section.id)}]${section.instrumentId ? ` | instrument: ${safe(section.instrumentId)}` : ''}`);
    lines.push(...fieldLines(section.fields));
  }
  lines.push('', `Zdarzenia (${report.events.length}):`);
  if (!report.events.length) lines.push('  brak zapisanych zdarzeń w przedstawionym wyniku; sprawdź pokrycie.');
  report.events.forEach((event, index) => { if (index) lines.push(''); lines.push(formatDiagnosticEvent(event, options)); });
  if (report.truncated) lines.push('', 'Wynik jest ucięty; część danych pominięto.');
  for (const omission of report.omissions) lines.push(`Pominięto: ${safe(omission)}`);
  return lines.join('\n');
}

function stable(event: DiagnosticEvent): string { return JSON.stringify(event); }
function isResolution(event: DiagnosticEvent): boolean {
  return /(?:^|_)(?:RESOLVED|RECOVERED|CLEARED|RESTORED)(?:_|$)/.test(event.code) ||
    /(?:^|_)(?:RESOLVED|RECOVERED|CLEARED|RESTORED)(?:_|$)/.test(event.reason);
}
function equivalent(a: DiagnosticEvent, b: DiagnosticEvent): boolean {
  const keys = ['instrumentId', 'conId', 'symbol', 'listing', 'reason', 'service', 'configHash', 'proposalId', 'brokerOrderId', 'lifecycleId', 'closeId', 'researchSnapshotId', 'implementationId', 'instanceId', 'revision'] as const;
  return keys.every(key => a[key] === b[key]) && !isResolution(a) && !isResolution(b) && a.severity !== 'ERROR' && a.severity !== 'CRITICAL' &&
    b.severity !== 'ERROR' && b.severity !== 'CRITICAL' && a.code === b.code && a.message === b.message &&
    a.impact === b.impact && a.action === b.action && JSON.stringify(a.fields) === JSON.stringify(b.fields);
}

/** Deduplicates identical stable IDs, orders by UTC occurrence then ID, and compacts only adjacent equivalent noncritical events. Conflicting ID versions are retained and marked with a visible version suffix. */
export function compactDiagnosticEvents(events: DiagnosticEvent[]): CompactedDiagnosticEvents {
  const byId = new Map<string, DiagnosticEvent[]>();
  for (const event of events) {
    const versions = byId.get(event.id) ?? [];
    if (!versions.some(existing => stable(existing) === stable(event))) versions.push(event);
    byId.set(event.id, versions);
  }
  const duplicateConflicts: string[] = [];
  const unique: DiagnosticEvent[] = [];
  for (const [id, versions] of byId) {
    if (versions.length > 1) duplicateConflicts.push(id);
    versions.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.recordedAt.localeCompare(b.recordedAt) || stable(a).localeCompare(stable(b)));
    versions.forEach((event, index) => unique.push(versions.length > 1 ? { ...event, id: `${id} [wersja ${index + 1}/${versions.length}]`, message: `${event.message} [konflikt wersji identyfikatora ${id}]` } : event));
  }
  unique.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.id.localeCompare(b.id) || a.recordedAt.localeCompare(b.recordedAt));
  const output: Array<DiagnosticEvent | CompactedDiagnosticEvent> = [];
  for (const event of unique) {
    const prior = output.at(-1);
    if (prior && !duplicateConflicts.includes(event.id) && equivalent(prior, event)) {
      const priorCompact = prior as CompactedDiagnosticEvent;
      output[output.length - 1] = { ...priorCompact, count: priorCompact.count + 1,
        lastOccurredAt: event.occurredAt, recordedAt: event.recordedAt,
        sourceEventIds: [...priorCompact.sourceEventIds, event.id],
        evaluationIds: event.evaluationId ? [...priorCompact.evaluationIds, event.evaluationId] : priorCompact.evaluationIds,
        auditRefs: event.auditRef ? [...priorCompact.auditRefs, event.auditRef] : priorCompact.auditRefs };
    } else output.push({ ...event, count: 1, firstOccurredAt: event.occurredAt, lastOccurredAt: event.occurredAt,
      sourceEventIds: [event.id], evaluationIds: event.evaluationId ? [event.evaluationId] : [],
      auditRefs: event.auditRef ? [event.auditRef] : [] });
  }
  return { events: output, duplicateConflicts: duplicateConflicts.sort() };
}
