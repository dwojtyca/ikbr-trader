const REQUEST_KEYS = [
  'conId',
  'filter',
  'fillWatchlist',
  'fillPortfolio',
  'fillCompetitors',
  'startDate',
  'endDate',
  'totalLimit',
] as const;

const ISIN_PATTERN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
const CANONICAL_POSITIVE_DECIMAL = /^[1-9][0-9]*$/;

export interface WshRequestInspection {
  kind: 'wsh-request-inspection-v1';
  shapeValid: boolean;
  issues: string[];
}

export interface WshEventRowInspection {
  kind: 'wsh-row-inspection-v1';
  rowsInspected: number;
  counts: {
    malformedRows: number;
    identityMatchedRows: number;
    identityMismatchedRows: number;
    identityUnverifiableRows: number;
    dateRows: number;
    instantRows: number;
    unknownDateTypeRows: number;
    announcementFieldPresentRows: number;
    announcementFieldAbsentRows: number;
    watchlistTaggedRows: number;
  };
  issues: string[];
}

const EMPTY_COUNTS = (): WshEventRowInspection['counts'] => ({
  malformedRows: 0,
  identityMatchedRows: 0,
  identityMismatchedRows: 0,
  identityUnverifiableRows: 0,
  dateRows: 0,
  instantRows: 0,
  unknownDateTypeRows: 0,
  announcementFieldPresentRows: 0,
  announcementFieldAbsentRows: 0,
  watchlistTaggedRows: 0,
});

function invalidRequestShape(): WshRequestInspection {
  return {
    kind: 'wsh-request-inspection-v1',
    shapeValid: false,
    issues: ['INVALID_SHAPE'],
  };
}

function isRecord(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) return false;
  try {
    return !Array.isArray(value);
  } catch {
    return false;
  }
}

function ownDataDescriptors(
  value: object,
  maximumKeys: number,
): Map<string, PropertyDescriptor> | null {
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length > maximumKeys || keys.some((key) => typeof key !== 'string')) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = new Map<string, PropertyDescriptor>();
    for (const key of keys) {
      if (typeof key !== 'string') return null;
      const descriptor = descriptors[key];
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return null;
      result.set(key, descriptor);
    }
    return result;
  } catch {
    return null;
  }
}

function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (year < 1000 || year > 9999 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1]!;
}

export function inspectWshRequest(input: unknown): WshRequestInspection {
  if (!isRecord(input)) return invalidRequestShape();

  let values: Map<string, unknown>;
  try {
    if (Object.getPrototypeOf(input) !== Object.prototype) return invalidRequestShape();
    const keys = Reflect.ownKeys(input);
    if (keys.length !== REQUEST_KEYS.length || keys.some((key) => typeof key !== 'string')) {
      return invalidRequestShape();
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    values = new Map();
    for (const key of REQUEST_KEYS) {
      if (!keys.includes(key)) return invalidRequestShape();
      const descriptor = descriptors[key];
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        return invalidRequestShape();
      }
      values.set(key, descriptor.value);
    }
  } catch {
    return invalidRequestShape();
  }

  const issues: string[] = [];
  const conId = values.get('conId');
  if (typeof conId !== 'number' || !Number.isSafeInteger(conId) || conId <= 0) {
    issues.push('INVALID_CONID');
  }
  const filter = values.get('filter');
  if (typeof filter !== 'string' || filter !== '') issues.push('UNSUPPORTED_FILTER_MODE');
  if (
    values.get('fillWatchlist') !== false ||
    values.get('fillPortfolio') !== false ||
    values.get('fillCompetitors') !== false
  ) {
    issues.push('FILL_FLAGS_NOT_FALSE');
  }
  const startDate = values.get('startDate');
  const endDate = values.get('endDate');
  if (
    !isValidDate(startDate) ||
    !isValidDate(endDate) ||
    startDate > endDate
  ) {
    issues.push('INVALID_DATE_RANGE');
  }
  const totalLimit = values.get('totalLimit');
  if (typeof totalLimit !== 'number' || !Number.isInteger(totalLimit) || totalLimit < 1 || totalLimit > 100) {
    issues.push('INVALID_TOTAL_LIMIT');
  }

  issues.sort();
  return {
    kind: 'wsh-request-inspection-v1',
    shapeValid: issues.length === 0,
    issues,
  };
}

function emptyRowInspection(issue: string): WshEventRowInspection {
  return {
    kind: 'wsh-row-inspection-v1',
    rowsInspected: 0,
    counts: EMPTY_COUNTS(),
    issues: [issue],
  };
}

function isValidIsin(value: unknown): value is string {
  return typeof value === 'string' && ISIN_PATTERN.test(value);
}

function inspectExpected(expected: unknown): { conId: number; isin: string } | null {
  if (!isRecord(expected)) return null;
  const descriptors = ownDataDescriptors(expected, 2);
  if (descriptors === null || descriptors.size !== 2 || !descriptors.has('conId') || !descriptors.has('isin')) {
    return null;
  }
  const conId = descriptors.get('conId')!.value;
  const isin = descriptors.get('isin')!.value;
  if (typeof conId !== 'number' || !Number.isSafeInteger(conId) || conId <= 0 || !isValidIsin(isin)) {
    return null;
  }
  return { conId, isin };
}

type ArrayInspection =
  | { kind: 'valid'; values: unknown[] }
  | { kind: 'invalid' }
  | { kind: 'oversized' }
  | { kind: 'accessor-or-reflection-failure' };

function inspectDenseArray(value: unknown, maximumLength: number, allowEmpty: boolean): ArrayInspection {
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    return { kind: 'accessor-or-reflection-failure' };
  }
  if (!isArray || !Array.isArray(value)) return { kind: 'invalid' };
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return { kind: 'invalid' };
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const length = lengthDescriptor?.value;
    if (typeof length !== 'number') return { kind: 'invalid' };
    if (length > maximumLength) return { kind: 'oversized' };
    if (!allowEmpty && length === 0) return { kind: 'invalid' };
    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        return { kind: 'accessor-or-reflection-failure' };
      }
    }
    if (keys.length !== length + 1 || keys.some((key) => typeof key !== 'string')) {
      return { kind: 'invalid' };
    }
    const values: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      if (!keys.includes(key)) return { kind: 'invalid' };
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) return { kind: 'invalid' };
      if (!Object.hasOwn(descriptor, 'value')) return { kind: 'accessor-or-reflection-failure' };
      values.push(descriptor.value);
    }
    return { kind: 'valid', values };
  } catch {
    return { kind: 'accessor-or-reflection-failure' };
  }
}

function validConids(value: unknown, expectedConid: number): { valid: boolean; containsExpected: boolean; fatal: boolean } {
  if (typeof value !== 'object' || value === null) {
    return { valid: false, containsExpected: false, fatal: false };
  }
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    return { valid: false, containsExpected: false, fatal: true };
  }
  if (!isArray) {
    try {
      const keys = Reflect.ownKeys(value);
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (keys.some((key) => {
        const descriptor = descriptors[key as string];
        return descriptor === undefined || !Object.hasOwn(descriptor, 'value');
      })) {
        return { valid: false, containsExpected: false, fatal: true };
      }
      return { valid: false, containsExpected: false, fatal: false };
    } catch {
      return { valid: false, containsExpected: false, fatal: true };
    }
  }
  const array = inspectDenseArray(value, 32, false);
  if (array.kind === 'accessor-or-reflection-failure') return { valid: false, containsExpected: false, fatal: true };
  if (array.kind !== 'valid') return { valid: false, containsExpected: false, fatal: false };
  const seen = new Set<string>();
  let containsExpected = false;
  for (const item of array.values) {
    if (typeof item !== 'string' || item.length > 16 || !CANONICAL_POSITIVE_DECIMAL.test(item)) {
      return { valid: false, containsExpected: false, fatal: false };
    }
    const parsed = Number(item);
    if (!Number.isSafeInteger(parsed) || seen.has(item)) {
      return { valid: false, containsExpected: false, fatal: false };
    }
    seen.add(item);
    if (parsed === expectedConid) containsExpected = true;
  }
  return { valid: true, containsExpected, fatal: false };
}

interface InspectedObject {
  descriptors: Map<string, PropertyDescriptor> | null;
  malformed: boolean;
}

function inspectObject(value: unknown, maximumKeys = 128): InspectedObject {
  if (typeof value !== 'object' || value === null) return { descriptors: null, malformed: false };
  try {
    if (Array.isArray(value)) return { descriptors: null, malformed: true };
  } catch {
    return { descriptors: null, malformed: true };
  }
  const descriptors = ownDataDescriptors(value, maximumKeys);
  return { descriptors, malformed: descriptors === null };
}

function rowIssueCodes(counts: WshEventRowInspection['counts']): string[] {
  const issues: string[] = [];
  if (counts.malformedRows > 0) issues.push('MALFORMED_ROWS');
  if (counts.identityMismatchedRows > 0) issues.push('IDENTITY_MISMATCH');
  if (counts.identityUnverifiableRows > 0) issues.push('IDENTITY_UNVERIFIABLE');
  if (counts.unknownDateTypeRows > 0) issues.push('UNKNOWN_DATE_TYPE');
  if (counts.announcementFieldAbsentRows > 0) issues.push('ANNOUNCEMENT_FIELDS_ABSENT');
  if (counts.watchlistTaggedRows > 0) issues.push('WATCHLIST_TAG_OBSERVED');
  return issues.sort();
}

export function inspectWshEventRows(input: unknown, expected: unknown): WshEventRowInspection {
  const identity = inspectExpected(expected);
  if (identity === null) return emptyRowInspection('EXPECTED_IDENTITY_INVALID');

  const rows = inspectDenseArray(input, 1000, true);
  if (rows.kind === 'accessor-or-reflection-failure') return emptyRowInspection('INVALID_ROWS');
  if (rows.kind === 'oversized') return emptyRowInspection('ROW_LIMIT_EXCEEDED');
  if (rows.kind === 'invalid') return emptyRowInspection('INVALID_ROWS');

  const counts = EMPTY_COUNTS();
  for (const rawRow of rows.values) {
    const rowObject = inspectObject(rawRow);
    if (rowObject.descriptors === null) {
      counts.malformedRows += 1;
      continue;
    }
    const row = rowObject.descriptors;
    const dataValue = row.get('data')?.value;
    const dataObject = inspectObject(dataValue);
    if (dataObject.malformed) {
      counts.malformedRows += 1;
      continue;
    }
    const data = dataObject.descriptors;
    const companyValue = data?.get('company')?.value;
    const companyObject = companyValue === undefined
      ? { descriptors: null, malformed: false }
      : inspectObject(companyValue);
    if (companyObject.malformed) {
      counts.malformedRows += 1;
      continue;
    }
    const company = companyObject.descriptors;

    let identityClass: 'matched' | 'mismatched' | 'unverifiable' = 'unverifiable';
    const conidsValue = row.get('conids')?.value;
    const conids = validConids(conidsValue, identity.conId);
    if (conids.fatal) {
      counts.malformedRows += 1;
      continue;
    }
    const isin = company?.get('isin')?.value;
    if (conids.valid && isValidIsin(isin)) {
      identityClass = conids.containsExpected && isin === identity.isin ? 'matched' : 'mismatched';
    }

    if (identityClass === 'matched') counts.identityMatchedRows += 1;
    else if (identityClass === 'mismatched') counts.identityMismatchedRows += 1;
    else counts.identityUnverifiableRows += 1;

    const dateType = row.get('index_date_type')?.value;
    if (dateType === 'DATE') counts.dateRows += 1;
    else if (dateType === 'INSTANT') counts.instantRows += 1;
    else counts.unknownDateTypeRows += 1;

    const announcementPresent = data !== null && [...data.entries()].some(([key, descriptor]) =>
      key.startsWith('announce_') &&
      typeof descriptor.value === 'string' &&
      descriptor.value.length <= 2000 &&
      descriptor.value.trim().length > 0,
    );
    if (announcementPresent) counts.announcementFieldPresentRows += 1;
    else counts.announcementFieldAbsentRows += 1;

    if (row.get('filterSource')?.value === 'watchlist') counts.watchlistTaggedRows += 1;
  }

  return {
    kind: 'wsh-row-inspection-v1',
    rowsInspected: rows.values.length,
    counts,
    issues: rowIssueCodes(counts),
  };
}
