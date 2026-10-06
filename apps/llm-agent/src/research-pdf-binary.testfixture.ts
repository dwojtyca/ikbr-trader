import type { PdfTextDocument } from "./research-pdf-types.js";

// Minimal actual PDF for decoder tests; values and geometry come from each test.
export function pdfBytes(document: PdfTextDocument, rotate = 0, userUnit = 1): Buffer {
  const objects: string[] = [];
  const pages = Array.from({ length: document.pageCount }, (_, i) => 4 + i * 2);
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map(n => `${n} 0 R`).join(" ")}] >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (let i = 0; i < pages.length; i++) {
    const page = document.pages.find(p => p.pageNumber === i + 1);
    const width = page?.width ?? 600, height = page?.height ?? 800;
    const content = (page?.items ?? []).map(item => {
      const font = Math.min(7, item.bottom - item.top - 0.1);
      const escaped = item.text.replace(/[\\()]/g, match => "\\" + match);
      return `BT /F1 ${font} Tf 25 Tz 1 0 0 1 ${item.left} ${height - item.bottom} Tm (${escaped}) Tj ET`;
    }).join("\n");
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Rotate ${rotate} /UserUnit ${userUnit} /Resources << /Font << /F1 3 0 R >> >> /Contents ${pages[i] + 1} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  let output = "%PDF-1.7\n", offsets = "0000000000 65535 f \n";
  for (let i = 0; i < objects.length; i++) {
    offsets += String(Buffer.byteLength(output)).padStart(10, "0") + " 00000 n \n";
    output += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n${offsets}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}
