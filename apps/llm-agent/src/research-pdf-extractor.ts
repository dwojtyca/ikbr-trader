import { createHash } from "node:crypto";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { PDF_RESEARCH_LIMITS, type PdfTextDocument } from "./research-pdf-types.js";

const FAILURE_CODES = new Set([
  "RESEARCH_PDF_DECODE_FAILED", "RESEARCH_PDF_ENCRYPTED", "RESEARCH_PDF_PAGE_LIMIT",
  "RESEARCH_PDF_PAGE_MISSING", "RESEARCH_PDF_GEOMETRY_UNSUPPORTED", "RESEARCH_PDF_TEXT_LIMIT",
  "RESEARCH_PDF_TEXT_MISSING",
]);

// Only local bytes enter PDF.js. The fixed worker has no URL, rendering or script API.
const DECODER = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { bytes, pageNumbers, limits, moduleUrl } = workerData;
(async () => {
  let task, document, encrypted = false;
  const fail = code => { throw new Error(code); };
  try {
    const { getDocument } = await import(moduleUrl);
    task = getDocument({ data: bytes, useSystemFonts: false, useWorkerFetch: false,
      isEvalSupported: false, disableFontFace: true, stopAtErrors: true, enableXfa: false,
      disableAutoFetch: true, disableStream: true, disableRange: true, verbosity: 0 });
    task.onPassword = () => { encrypted = true; void task.destroy(); };
    document = await task.promise;
    if (encrypted || await document.getPermissions() !== null) fail("RESEARCH_PDF_ENCRYPTED");
    if (document.numPages > limits.maxPages) fail("RESEARCH_PDF_PAGE_LIMIT");
    if (pageNumbers.some(n => n > document.numPages)) fail("RESEARCH_PDF_PAGE_MISSING");
    const pages = [];
    let itemCount = 0, textBytes = 0;
    for (const pageNumber of pageNumbers) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      if (page.rotate !== 0 || page.userUnit !== 1 || page.view[0] !== 0 || page.view[1] !== 0 ||
          !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) ||
          viewport.width <= 0 || viewport.height <= 0) fail("RESEARCH_PDF_GEOMETRY_UNSUPPORTED");
      const items = [], reader = page.streamTextContent({ disableNormalization: true }).getReader();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          for (const item of chunk.value.items) {
            if (++itemCount > limits.maxTextItems) fail("RESEARCH_PDF_TEXT_LIMIT");
            if (typeof item.str !== "string") continue;
            textBytes += Buffer.byteLength(item.str, "utf8");
            if (textBytes > limits.maxTextBytes) fail("RESEARCH_PDF_TEXT_LIMIT");
            if (!item.str.trim()) continue;
            const t = item.transform;
            if (!Array.isArray(t) || t.length !== 6 || !t.every(Number.isFinite) ||
                t[0] <= 0 || t[3] <= 0 || Math.abs(t[1]) > 0.000001 || Math.abs(t[2]) > 0.000001 ||
                !Number.isFinite(item.width) || !Number.isFinite(item.height) || item.width <= 0 || item.height <= 0)
              fail("RESEARCH_PDF_GEOMETRY_UNSUPPORTED");
            const left = t[4], right = left + item.width, bottom = viewport.height - t[5], top = bottom - item.height;
            if (![left, right, top, bottom].every(Number.isFinite) || left < 0 || top < 0 || right > viewport.width + 0.01 || bottom > viewport.height + 0.01)
              fail("RESEARCH_PDF_GEOMETRY_UNSUPPORTED");
            items.push({ text: item.str, left, right, top, bottom });
          }
        }
      } finally { await reader.cancel(new Error("RESEARCH_PDF_STREAM_CLOSED")); reader.releaseLock(); page.cleanup(); }
      if (!items.length) fail("RESEARCH_PDF_TEXT_MISSING");
      pages.push({ pageNumber, width: viewport.width, height: viewport.height, items });
    }
    parentPort.postMessage({ document: { pageCount: document.numPages, pages } });
  } catch (error) {
    const known = new Set(${JSON.stringify([...FAILURE_CODES])});
    parentPort.postMessage({ error: encrypted ? "RESEARCH_PDF_ENCRYPTED" : known.has(error?.message) ? error.message : "RESEARCH_PDF_DECODE_FAILED" });
  } finally {
    if (document) await document.destroy();
    else if (task) await task.destroy();
  }
})();
`;

type DecoderWorker = Pick<Worker, "on" | "terminate">;
type WorkerFactory = (code: string, options: WorkerOptions) => DecoderWorker;

export async function extractResearchPdf(bytes: Uint8Array, documentSha256: string, pageNumbers: readonly number[],
  dependencies: { createWorker?: WorkerFactory } = {}): Promise<PdfTextDocument> {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > PDF_RESEARCH_LIMITS.maxBytes) throw new Error("RESEARCH_PDF_BYTE_LIMIT");
  if (!/^[a-f0-9]{64}$/.test(documentSha256) || createHash("sha256").update(bytes).digest("hex") !== documentSha256) throw new Error("RESEARCH_PDF_DIGEST_MISMATCH");
  if (!Buffer.from(bytes.subarray(0, 5)).equals(Buffer.from("%PDF-"))) throw new Error("RESEARCH_PDF_MAGIC_INVALID");
  if (!pageNumbers.length || pageNumbers.length > PDF_RESEARCH_LIMITS.maxSelectedPages || new Set(pageNumbers).size !== pageNumbers.length ||
      pageNumbers.some(n => !Number.isInteger(n) || n < 1 || n > PDF_RESEARCH_LIMITS.maxPages)) throw new Error("RESEARCH_PDF_SELECTION_INVALID");
  const copy = Uint8Array.from(bytes);
  const worker = (dependencies.createWorker ?? ((code, options) => new Worker(code, options)))(DECODER, {
    eval: true,
    execArgv: [],
    workerData: { bytes: copy, pageNumbers: [...pageNumbers], limits: PDF_RESEARCH_LIMITS, moduleUrl: import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs") },
    transferList: [copy.buffer],
    resourceLimits: { maxOldGenerationSizeMb: PDF_RESEARCH_LIMITS.heapMb, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    // PDF.js diagnostics are not source evidence and may include untrusted document text.
    stdout: true, stderr: true,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<PdfTextDocument>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("RESEARCH_PDF_TIMEOUT")), PDF_RESEARCH_LIMITS.timeoutMs);
      worker.on("message", (message: { error?: unknown; document?: PdfTextDocument }) => {
        if (typeof message?.error === "string") reject(new Error(FAILURE_CODES.has(message.error) ? message.error : "RESEARCH_PDF_DECODE_FAILED"));
        else if (message?.document && Number.isInteger(message.document.pageCount) && Array.isArray(message.document.pages)) resolve(message.document);
        else reject(new Error("RESEARCH_PDF_DECODE_FAILED"));
      });
      worker.on("error", () => reject(new Error("RESEARCH_PDF_DECODE_FAILED")));
      worker.on("exit", () => reject(new Error("RESEARCH_PDF_DECODE_FAILED")));
    });
  } finally {
    if (timer) clearTimeout(timer);
    await worker.terminate();
  }
}
