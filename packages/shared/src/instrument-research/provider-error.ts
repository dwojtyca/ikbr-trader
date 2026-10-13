import { safeDiagnosticText, type DiagnosticPrivacy } from "../diagnostics/privacy.js";
import type { ResearchProviderError } from "./types.js";

export function isResearchProviderError(value: unknown): value is ResearchProviderError {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join(",") === "code,message" &&
    (row.code === null || Number.isSafeInteger(row.code)) &&
    typeof row.message === "string" && row.message.length > 0 && row.message.length <= 1000 &&
    !/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/u.test(row.message);
}

export function sanitizeResearchProviderError(code: unknown, message: string, privacy: DiagnosticPrivacy = {}): ResearchProviderError {
  return { code: Number.isSafeInteger(code) ? code as number : null,
    message: safeDiagnosticText(message, privacy).slice(0, 1000) || "Brak opisu błędu od dostawcy." };
}

export function formatResearchProviderError(value: unknown, privacy: DiagnosticPrivacy = {}): string {
  if (!isResearchProviderError(value)) return "Oryginalny opis błędu niedostępny w zapisanych danych.";
  const error = sanitizeResearchProviderError(value.code, value.message, privacy);
  return `Kod dostawcy: ${error.code ?? "brak"}; komunikat: ${error.message}`;
}
