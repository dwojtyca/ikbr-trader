import { useEffect, useState } from "react";
import { fetchOperatorApi } from "./trading-loop";

type Audit = {
  binding: { configHash: string; manifestHash: string; instrumentId: string; snapshotId: string; snapshotHash: string; sequence: number } | null;
  snapshot: { id: string; hash: string; sequence: number; snapshot: {
    createdAt: string;
    coverage: { sourceId: string; role: string; status: string; checkedAt: string; windowStart: string; windowEnd: string; complete: boolean; reason: string; evidenceRefs: string[] }[];
    evidence: { ref: string; sourceId: string; documentId: string; url: string; contentHash: string; published: unknown; fetchedAt: string; observedAt: string; automation: string; retention: string }[];
    facts: { id: string; metric: string; value: number; scale: number; unit: string; currency: string | null; periodStart: string | null; periodEnd: string; periodType: string; scope: string; evidenceRef: string; sourcePointer: string; supersedes: string | null }[];
    reports: { id: string; kind: string; periodStart: string; periodEnd: string; scope: string; evidenceRef: string; supersedes: string | null }[];
    news: { id: string; title: string; evidenceRef: string }[];
    events: { id: string; kind: string; title: string; evidenceRef: string; occurs: unknown }[];
  } } | null;
  review: { status: string | null; expiresAt: string | null; decision: unknown; executionRisk: unknown };
  modelCall: { requestHash: string; request: unknown; startedAt: string; deadlineAt: string; outcome: unknown; receivedAt: string | null } | null;
};

export function safeAuditUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443") || !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(url.hostname) || /\.(local|localhost|internal|test|invalid|example)$/i.test(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}

function valueText(value: unknown): string {
  return value == null ? "-" : typeof value === "string" ? value : JSON.stringify(value);
}

export function ResearchAudit({ orderId }: { orderId: number }) {
  const [audit, setAudit] = useState<Audit | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setAudit(null); setError(null);
    void fetchOperatorApi(`/api/execution/execution/orders/${orderId}/research`, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`Research audit unavailable (${response.status})`);
        return response.json() as Promise<Audit>;
      })
      .then(setAudit)
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Research audit unavailable"); });
    return () => controller.abort();
  }, [orderId]);

  if (error) return <p role="alert">{error}</p>;
  if (!audit) return <p>Loading research audit…</p>;
  const snapshot = audit.snapshot?.snapshot;
  return <section aria-label="Research audit" className="research-audit" style={{ overflowWrap: "anywhere" }}>
    <h4>Research audit</h4>
    <dl>
      <dt>Review</dt><dd>{audit.review.status ?? "No review"}</dd>
      <dt>Review expires</dt><dd>{audit.review.expiresAt ?? "-"}</dd>
      <dt>Instrument</dt><dd>{audit.binding?.instrumentId ?? "Unbound"}</dd>
      <dt>Configuration hash</dt><dd>{audit.binding?.configHash ?? "-"}</dd>
      <dt>Manifest hash</dt><dd>{audit.binding?.manifestHash ?? "-"}</dd>
      <dt>Snapshot</dt><dd>{audit.binding ? `${audit.binding.snapshotId} · sequence ${audit.binding.sequence} · ${audit.binding.snapshotHash}` : "-"}</dd>
      <dt>Snapshot created</dt><dd>{snapshot?.createdAt ?? "-"}</dd>
      <dt>Decision and risk flags</dt><dd><pre>{valueText(audit.review.decision)}</pre><pre>{valueText(audit.review.executionRisk)}</pre></dd>
      <dt>Model request hash</dt><dd>{audit.modelCall?.requestHash ?? "-"}</dd>
      <dt>Model started / deadline / received</dt><dd>{audit.modelCall ? `${audit.modelCall.startedAt} / ${audit.modelCall.deadlineAt} / ${audit.modelCall.receivedAt ?? "-"}` : "-"}</dd>
      <dt>Model request</dt><dd><pre>{valueText(audit.modelCall?.request)}</pre></dd>
      <dt>Model outcome</dt><dd><pre>{valueText(audit.modelCall?.outcome)}</pre></dd>
    </dl>
    {snapshot && <>
      <h5>Source coverage</h5>
      <ul>{snapshot.coverage.map((row, index) => <li key={`${row.sourceId}:${row.role}:${index}`}>{row.sourceId} · {row.role} · {row.status} · complete {String(row.complete)} · checked {row.checkedAt} · window {row.windowStart}–{row.windowEnd} · evidence {row.evidenceRefs.join(", ") || "none"} · {row.reason}</li>)}</ul>
      <h5>Evidence and sources</h5>
      <ul>{snapshot.evidence.map(row => {
        const href = safeAuditUrl(row.url);
        return <li key={row.ref}>{row.ref} · {row.sourceId} · {row.documentId} · {href ? <a href={href} target="_blank" rel="noopener noreferrer">{row.url}</a> : row.url} · digest {row.contentHash} · published {valueText(row.published)} · fetched {row.fetchedAt} · observed {row.observedAt} · automation {row.automation} · retention {row.retention}</li>;
      })}</ul>
      <h5>Reports and facts</h5>
      <ul>{snapshot.reports.map(row => <li key={row.id}>{row.id} · {row.kind} · {row.scope} · period {row.periodStart}–{row.periodEnd} · {row.evidenceRef} · supersedes {row.supersedes ?? "none"}</li>)}</ul>
      <ul>{snapshot.facts.map(row => <li key={row.id}>{row.metric}: {row.value * row.scale} {row.unit} {row.currency ?? ""} (source {row.value} × {row.scale}) · {row.periodType} · {row.scope} · {row.periodStart ?? "instant"}–{row.periodEnd} · {row.evidenceRef} · {row.sourcePointer} · supersedes {row.supersedes ?? "none"}</li>)}</ul>
      <h5>News and events</h5>
      <ul>{snapshot.news.map(row => <li key={row.id}>{row.title} · {row.evidenceRef}</li>)}{snapshot.events.map(row => <li key={row.id}>{row.kind}: {row.title} · {valueText(row.occurs)} · {row.evidenceRef}</li>)}</ul>
    </>}
  </section>;
}
