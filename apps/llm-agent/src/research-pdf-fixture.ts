import { readFileSync } from "node:fs";
import type { ResearchInstrumentPolicy } from "@ikbr/shared/instrument-research";
import { parseIssuerPdfMapping } from "./research-pdf-mapping.js";
import type { PdfRectangle, PdfTextDocument, PdfTextItem } from "./research-pdf-types.js";

const inset = (text: string, box: PdfRectangle): PdfTextItem => ({ text, left: box.left + 1, right: box.right - 1, top: box.top + 1, bottom: box.bottom - 1 });

export function issuerPdfFixture() {
  const example = JSON.parse(readFileSync(new URL("../../../config/research/paper.example.json", import.meta.url), "utf8")) as { instruments: ResearchInstrumentPolicy[] };
  const policy = example.instruments.find(item => item.instrumentId === "pko_wse")!;
  const source = policy.sources.find(item => item.id === "latest_periodic")!;
  const mapping = parseIssuerPdfMapping(source.parserConfig);
  const values: Record<string, string> = { net_interest_income: "23,456", net_profit: "(7,654)", loans: "123 456", deposits: "987,654", tier1_ratio: "18.25" };
  mapping.authorityDecisions[0].corroborating.value = 18.25;
  source.parserConfig = mapping;
  const document: PdfTextDocument = { pageCount: mapping.pageCount, pages: mapping.pages.map(spec => {
    const items = Object.values(spec.markers).map(marker => inset(marker.text, marker.rect));
    for (const table of spec.tables) {
      items.push(inset(table.title.text, table.title.rect));
      for (const col of table.columns) items.push(inset(col.header.text, col.header.rect));
      for (const fact of table.facts) {
        if (fact.metric === "net_profit") {
          const mid = (fact.row.rect.top + fact.row.rect.bottom) / 2;
          items.push(inset("Net profit attributable to equity holders of the", { ...fact.row.rect, bottom: mid }));
          items.push(inset("parent company", { ...fact.row.rect, top: mid }));
        } else items.push(inset(fact.row.text, fact.row.rect));
        for (const col of table.columns) items.push(inset(col.id === fact.columnId ? values[fact.metric] : "9,999", { left: col.left, right: col.right, top: fact.row.rect.top, bottom: fact.row.rect.bottom }));
      }
    }
    return { pageNumber: spec.pageNumber, width: spec.width, height: spec.height, items };
  }) };
  return { policy, source, mapping, document, fetchedAt: "2026-10-06T21:00:00Z" };
}
