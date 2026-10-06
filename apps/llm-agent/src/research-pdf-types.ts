export interface PdfRectangle {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PdfTextItem extends PdfRectangle {
  text: string;
}

export interface PdfTextPage {
  pageNumber: number;
  width: number;
  height: number;
  items: PdfTextItem[];
}

export interface PdfTextDocument {
  pageCount: number;
  pages: PdfTextPage[];
}

export const PDF_RESEARCH_LIMITS = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  maxPages: 100,
  maxSelectedPages: 12,
  maxTextItems: 100_000,
  maxTextBytes: 1024 * 1024,
  timeoutMs: 12_000,
  heapMb: 256,
});
