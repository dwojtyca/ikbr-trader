import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import type { Worker, WorkerOptions } from "node:worker_threads";
import { extractResearchPdf } from "./research-pdf-extractor.js";
import { PDF_RESEARCH_LIMITS, type PdfTextDocument } from "./research-pdf-types.js";
import { pdfBytes } from "./research-pdf-binary.testfixture.js";
import { issuerPdfFixture } from "./research-pdf-fixture.js";
import { normalizeResearchSource } from "./research-providers.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const simple: PdfTextDocument = { pageCount: 1, pages: [{ pageNumber: 1, width: 600, height: 800,
  items: [{ text: "Actual decoded value 42", left: 20, right: 300, top: 30, bottom: 40 }] }] };

test("actual binary decoder selects pages and yields coordinate-bound financial values", async () => {
  const fixture = issuerPdfFixture();
  for (const page of fixture.document.pages) for (const item of page.items) if (item.text === "123 456") item.text = "123,456";
  const bytes = pdfBytes(fixture.document);
  fixture.mapping.documentSha256 = hash(bytes);
  fixture.mapping.authorityDecisions[0].selected.documentSha256 = hash(bytes);
  fixture.source.parserConfig = fixture.mapping;
  const document = await extractResearchPdf(bytes, hash(bytes), [5, 7, 33]);
  assert.equal(document.pageCount, 36);
  assert.equal(document.pages.length, 3);
  const result = normalizeResearchSource(fixture.policy, fixture.source, document, fixture.fetchedAt, fixture.source.urls[0], hash(bytes));
  assert.ok("facts" in result);
  assert.deepEqual(result.facts.map(f => f.value), [23456, -7654, 123456, 987654, 18.25]);
});

test("byte/digest/magic/page guards reject before a worker starts", async () => {
  let calls = 0;
  const deps = { createWorker: () => { calls++; throw new Error("worker must not start"); } };
  const bytes = pdfBytes(simple);
  await assert.rejects(extractResearchPdf(new Uint8Array(PDF_RESEARCH_LIMITS.maxBytes + 1), hash(bytes), [1], deps), /BYTE_LIMIT/);
  await assert.rejects(extractResearchPdf(bytes, "a".repeat(64), [1], deps), /DIGEST_MISMATCH/);
  const html = Buffer.from("<html>error</html>");
  await assert.rejects(extractResearchPdf(html, hash(html), [1], deps), /MAGIC_INVALID/);
  for (const selection of [[], [0], [1, 1], [1.2], [101], Array.from({ length: 13 }, (_, i) => i + 1)])
    await assert.rejects(extractResearchPdf(bytes, hash(bytes), selection, deps), /SELECTION_INVALID/);
  assert.equal(calls, 0);
});

test("actual decoder rejects malformed, encrypted, blank, rotated and excessive-page PDFs", async () => {
  const malformed = Buffer.from("%PDF-not-a-document");
  await assert.rejects(extractResearchPdf(malformed, hash(malformed), [1]), /DECODE_FAILED/);
  const encrypted = await readFile(new URL("./research-provider-fixtures/encrypted-test.pdf", import.meta.url));
  await assert.rejects(extractResearchPdf(encrypted, hash(encrypted), [1]), /ENCRYPTED/);
  for (const [bytes, error] of [
    [pdfBytes({ pageCount: 1, pages: [] }), /TEXT_MISSING/],
    [pdfBytes(simple, 90), /GEOMETRY_UNSUPPORTED/],
    [pdfBytes(simple, 0, 2), /GEOMETRY_UNSUPPORTED/],
    [pdfBytes({ ...simple, pageCount: 101 }), /PAGE_LIMIT/],
  ] as const) await assert.rejects(extractResearchPdf(bytes, hash(bytes), [1]), error);
  const bytes = pdfBytes(simple);
  await assert.rejects(extractResearchPdf(bytes, hash(bytes), [2]), /PAGE_MISSING/);
});

test("actual decoder bounds extracted text", async () => {
  const bytes = pdfBytes({ ...simple, pages: [{ ...simple.pages[0], width: 2000,
    items: Array.from({ length: 1100 }, () => ({ ...simple.pages[0].items[0], text: "x".repeat(1000) })) }] });
  await assert.rejects(extractResearchPdf(bytes, hash(bytes), [1]), /TEXT_LIMIT/);
});

test("worker timeout/error/success always awaits termination and never returns decoder messages", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const bytes = pdfBytes(simple);
  for (const outcome of ["timeout", "error", "unknown", "exit", "success"] as const) {
    let terminated = false, options: WorkerOptions | undefined;
    const worker = new EventEmitter() as EventEmitter & { terminate: () => Promise<number> };
    worker.terminate = async () => { await Promise.resolve(); terminated = true; return 0; };
    const promise = extractResearchPdf(bytes, hash(bytes), [1], { createWorker: (_code, value) => { options = value; return worker as unknown as Worker; } });
    const check = outcome === "success" ? promise : assert.rejects(promise, outcome === "timeout" ? /TIMEOUT/ : /^Error: RESEARCH_PDF_DECODE_FAILED$/);
    if (outcome === "timeout") t.mock.timers.tick(PDF_RESEARCH_LIMITS.timeoutMs);
    if (outcome === "error") worker.emit("error", new Error("untrusted PDF contents"));
    if (outcome === "unknown") worker.emit("message", { error: "untrusted PDF contents" });
    if (outcome === "exit") worker.emit("exit", 1);
    if (outcome === "success") worker.emit("message", { document: simple });
    await check;
    assert.equal(terminated, true);
    assert.equal(options?.resourceLimits?.maxOldGenerationSizeMb, 256);
    assert.deepEqual(options?.execArgv, []);
    assert.equal(options?.stdout, true); assert.equal(options?.stderr, true);
  }
});
