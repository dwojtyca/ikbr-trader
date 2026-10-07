import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { accountingError, type SourceSettingsV1, type OperatorQualificationV1 } from "./types.js";

const text = z.string().trim().min(1).max(200);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.string().datetime({ offset: true });
export const sourceSettingsSchema = z.object({ schemaVersion: z.literal(1), sourceKind: z.literal("ibkr-tws-seven-day-v1"),
  environment: z.literal("paper"), accountId: text, endpoint: z.object({ host: text, port: z.number().int().min(1).max(65535) }).strict(),
  sourceClientId: z.literal(0), executionTimeZone: z.enum(["UTC", "Europe/Warsaw"]) }).strict();
export const qualificationSchema = z.object({ schemaVersion: z.literal(1), sourceKind: z.literal("ibkr-tws-seven-day-v1"),
  settingsSha256: sha, inspectionId: z.string().uuid(), operator: text, observedAt: instant,
  product: z.literal("TWS"), productVersion: text, productBuild: text, tradeLogDays: z.literal(7), masterClientId: z.literal(0),
  executionTimeZone: z.enum(["UTC", "Europe/Warsaw"]), confirmations: z.object({ exactEndpointAndAccount: z.literal(true),
    evidenceBelongsToCurrentHostSession: z.literal(true), noSettingsChangeSinceEvidence: z.literal(true), pauseAndRequalifyBeforeSettingsChange: z.literal(true) }).strict(),
  artifacts: z.array(z.object({ kind: z.enum(["tws-product-build", "tws-trade-log-seven-days", "tws-master-client-zero", "execution-timezone"]),
    relativePath: z.string().min(1).max(300), sha256: sha, observedAt: instant }).strict()).length(4),
}).strict();
export function privateFile(path: string, maxBytes: number): Buffer {
  if (!isAbsolute(path)) throw accountingError("PRIVATE_FILE_INVALID");
  const st = lstatSync(path), parent = lstatSync(dirname(path));
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o600 || st.size > maxBytes || !parent.isDirectory()
    || parent.isSymbolicLink() || (parent.mode & 0o777) !== 0o700 || realpathSync(path) !== resolve(path)) throw accountingError("PRIVATE_FILE_INVALID");
  return readFileSync(path);
}
export function loadAccountingSettings(input: { path?: string; sha256?: string; environment: string; host: string; port: number;
  accountId?: string; allowedAccounts: readonly string[]; timeZone?: string; clientIds: Array<number | undefined> }): { settings: SourceSettingsV1; sha256: string } | undefined {
  if (!input.path && !input.sha256) return undefined;
  if (!input.path || !input.sha256 || !sha.safeParse(input.sha256).success) throw accountingError("SETTINGS_MISMATCH");
  const bytes = privateFile(input.path, 16_384);
  if (createHash("sha256").update(bytes).digest("hex") !== input.sha256) throw accountingError("SETTINGS_MISMATCH");
  const result = sourceSettingsSchema.safeParse(JSON.parse(bytes.toString("utf8")));
  if (!result.success) throw accountingError("SETTINGS_MISMATCH");
  const settings = result.data;
  if (input.environment !== "paper" || !input.allowedAccounts.includes(settings.accountId) || input.accountId && input.accountId !== settings.accountId
    || settings.endpoint.host !== input.host || settings.endpoint.port !== input.port || settings.executionTimeZone !== input.timeZone
    || input.clientIds.includes(0)) throw accountingError("SETTINGS_MISMATCH");
  return { settings, sha256: input.sha256 };
}
export function parseQualification(value: unknown, nowMs: number): OperatorQualificationV1 {
  const parsed = qualificationSchema.safeParse(value);
  if (!parsed.success) throw accountingError("QUALIFICATION_INVALID");
  const v = parsed.data;
  if (new Set(v.artifacts.map(a => a.kind)).size !== 4 || [v.observedAt, ...v.artifacts.map(a => a.observedAt)]
    .some(t => Date.parse(t) > nowMs || nowMs - Date.parse(t) > 30 * 60_000)) throw accountingError("QUALIFICATION_INVALID");
  return v;
}
export function verifyQualificationArtifacts(value: OperatorQualificationV1, evidenceDir: string): void {
  if (!isAbsolute(evidenceDir)) throw accountingError("PRIVATE_FILE_INVALID");
  let size = 0;
  for (const artifact of value.artifacts) {
    const path = resolve(evidenceDir, artifact.relativePath), rel = relative(evidenceDir, path);
    if (isAbsolute(artifact.relativePath) || rel.startsWith("..") || !/\.(png|jpe?g|txt)$/i.test(path)) throw accountingError("PRIVATE_FILE_INVALID");
    const bytes = privateFile(path, 5 * 1024 * 1024); size += bytes.length;
    if (size > 20 * 1024 * 1024 || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw accountingError("ARTIFACT_MISMATCH");
    if (/\.png$/i.test(path) && !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw accountingError("ARTIFACT_MISMATCH");
    if (/\.jpe?g$/i.test(path) && (bytes[0] !== 255 || bytes[1] !== 216)) throw accountingError("ARTIFACT_MISMATCH");
    if (/\.txt$/i.test(path)) new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
}
