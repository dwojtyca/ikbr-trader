import assert from 'node:assert/strict';
import test from 'node:test';

import { inspectWshEventRows, inspectWshRequest } from './research-wsh-inspection.js';

const expected = { conId: 987654321, isin: 'ZZABCDEF1234' };

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conId: 987654321,
    filter: '',
    fillWatchlist: false,
    fillPortfolio: false,
    fillCompetitors: false,
    startDate: '20240229',
    endDate: '20240301',
    totalLimit: 100,
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conids: ['12', '987654321', '44'],
    company: { isin: expected.isin },
    announce_label: 'Synthetic announcement field',
    ...overrides,
  };
}

function wrappedRow(
  dataValue: unknown = row(),
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const descriptors = Object.getOwnPropertyDescriptors(dataValue as object);
  const conidsDescriptor = descriptors.conids;
  delete descriptors.conids;
  const data = Object.defineProperties({}, descriptors);
  const result: Record<string, unknown> = { index_date_type: 'DATE', filterSource: 'instrument', data, ...overrides };
  if (conidsDescriptor !== undefined) Object.defineProperty(result, 'conids', conidsDescriptor);
  return result;
}

function outcome(rows: unknown, identity: unknown = expected) {
  return inspectWshEventRows(rows, identity);
}

test('request accepts only the exact conservative shape and preserves no values', () => {
  const input = request();
  assert.deepEqual(inspectWshRequest(input), {
    kind: 'wsh-request-inspection-v1',
    shapeValid: true,
    issues: [],
  });
  assert.deepEqual(input, request());
});

test('request rejects non-objects, JSON strings, arrays, wrong prototypes, keys, symbols and missing keys', () => {
  for (const value of [null, ' null ', '"{}"', [], 3, Object.create(null)]) {
    assert.deepEqual(inspectWshRequest(value).issues, ['INVALID_SHAPE']);
  }
  assert.deepEqual(inspectWshRequest({ ...request(), extra: 'synthetic secret' }).issues, ['INVALID_SHAPE']);
  const missing = request();
  delete missing.endDate;
  assert.deepEqual(inspectWshRequest(missing).issues, ['INVALID_SHAPE']);
  const symbolKey = request();
  Object.defineProperty(symbolKey, Symbol('private'), { value: 'synthetic' });
  assert.deepEqual(inspectWshRequest(symbolKey).issues, ['INVALID_SHAPE']);
  let getterCalls = 0;
  const accessor = request();
  Object.defineProperty(accessor, 'filter', { get() { getterCalls += 1; return ''; } });
  assert.deepEqual(inspectWshRequest(accessor).issues, ['INVALID_SHAPE']);
  assert.equal(getterCalls, 0);
});

test('request catches throwing and revoked proxy reflection without exposing trap text', () => {
  const throwing = new Proxy(request(), {
    ownKeys() { throw new Error('synthetic private trap text'); },
  });
  assert.deepEqual(inspectWshRequest(throwing).issues, ['INVALID_SHAPE']);
  const revocable = Proxy.revocable(request(), {});
  revocable.revoke();
  assert.deepEqual(inspectWshRequest(revocable.proxy).issues, ['INVALID_SHAPE']);
});

test('request reports all independent fixed field issues in sorted order', () => {
  const result = inspectWshRequest(request({
    conId: Number.MAX_SAFE_INTEGER + 1,
    filter: { arbitrary: 'private' },
    fillWatchlist: true,
    fillPortfolio: 0,
    fillCompetitors: null,
    startDate: '19000229',
    endDate: '20240101',
    totalLimit: 101,
  }));
  assert.deepEqual(result.issues, [
    'FILL_FLAGS_NOT_FALSE',
    'INVALID_CONID',
    'INVALID_DATE_RANGE',
    'INVALID_TOTAL_LIMIT',
    'UNSUPPORTED_FILTER_MODE',
  ]);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('arbitrary'), false);
});

test('request validates Gregorian dates, ordering, limits and exact false flags', () => {
  for (const date of ['00000101', '20230229', '20241301', '2024011', '20240100']) {
    assert.ok(inspectWshRequest(request({ startDate: date })).issues.includes('INVALID_DATE_RANGE'));
  }
  assert.ok(inspectWshRequest(request({ startDate: '20240302', endDate: '20240301' })).issues.includes('INVALID_DATE_RANGE'));
  assert.equal(inspectWshRequest(request({ startDate: '20000229', endDate: '20000229' })).shapeValid, true);
  for (const conId of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '987654321']) {
    assert.ok(inspectWshRequest(request({ conId })).issues.includes('INVALID_CONID'));
  }
  for (const totalLimit of [0, 101, 1.5, Infinity, NaN, '100']) {
    assert.ok(inspectWshRequest(request({ totalLimit })).issues.includes('INVALID_TOTAL_LIMIT'));
  }
  for (const flag of [0, 1, null, undefined]) {
    assert.ok(inspectWshRequest(request({ fillPortfolio: flag })).issues.includes('FILL_FLAGS_NOT_FALSE'));
  }
  assert.equal(inspectWshRequest(request({ totalLimit: 1 })).shapeValid, true);
  assert.equal(inspectWshRequest(request({ totalLimit: 100 })).shapeValid, true);
});

test('rows classify valid identity once and allow multiple listing conIds', () => {
  const result = outcome([
    wrappedRow(row()),
    wrappedRow(row({ conids: ['7', '8'], company: { isin: expected.isin } })),
    wrappedRow(row({ conids: ['987654321'], company: { isin: 'YYABCDEF1234' } })),
    wrappedRow(row({ conids: ['7'], company: { isin: 'YYABCDEF1234' } })),
  ]);
  assert.equal(result.rowsInspected, 4);
  assert.deepEqual(result.counts, {
    malformedRows: 0,
    identityMatchedRows: 1,
    identityMismatchedRows: 3,
    identityUnverifiableRows: 0,
    dateRows: 4,
    instantRows: 0,
    unknownDateTypeRows: 0,
    announcementFieldPresentRows: 4,
    announcementFieldAbsentRows: 0,
    watchlistTaggedRows: 0,
  });
  assert.deepEqual(result.issues, ['IDENTITY_MISMATCH']);
});

test('rows distinguish unverifiable identity from malformed rows and count fixed observations', () => {
  const getterData = row();
  Object.defineProperty(getterData, 'conids', { get() { throw new Error('must not run'); } });
  const result = outcome([
    wrappedRow(row({ conids: ['not-decimal'], company: { isin: expected.isin } })),
    wrappedRow({ company: { isin: 'bad' } }),
    wrappedRow({ conids: ['987654321'] }),
    wrappedRow(getterData),
    wrappedRow(row({ conids: ['987654321'] }), { index_date_type: 'INSTANT', filterSource: 'watchlist' }),
    wrappedRow(row({ conids: ['987654321'], announce_blank: '  ' }), { index_date_type: 'other' }),
    wrappedRow(row({ conids: ['987654321'] }), { index_date_type: '' }),
  ]);
  assert.equal(result.rowsInspected, 7);
  assert.deepEqual(result.counts, {
    malformedRows: 1,
    identityMatchedRows: 3,
    identityMismatchedRows: 0,
    identityUnverifiableRows: 3,
    dateRows: 3,
    instantRows: 1,
    unknownDateTypeRows: 2,
    announcementFieldPresentRows: 4,
    announcementFieldAbsentRows: 2,
    watchlistTaggedRows: 1,
  });
  assert.deepEqual(result.issues, [
    'ANNOUNCEMENT_FIELDS_ABSENT',
    'IDENTITY_UNVERIFIABLE',
    'MALFORMED_ROWS',
    'UNKNOWN_DATE_TYPE',
    'WATCHLIST_TAG_OBSERVED',
  ]);
});

test('invalid expected identity returns only the boundary issue without inspecting input', () => {
  let inputGetterCalls = 0;
  const input = new Proxy([], {
    get() { inputGetterCalls += 1; throw new Error('must not run'); },
  });
  for (const bad of [null, { conId: 0, isin: expected.isin }, { conId: 1, isin: 'bad' }, { conId: 1, isin: expected.isin, extra: true }]) {
    const result = outcome(input, bad);
    assert.deepEqual(result.issues, ['EXPECTED_IDENTITY_INVALID']);
    assert.equal(result.rowsInspected, 0);
    assert.ok(Object.values(result.counts).every((count) => count === 0));
  }
  assert.equal(inputGetterCalls, 0);
});

test('row boundary rejects invalid arrays, holes, accessors, extra keys, symbols and limits', () => {
  const sparse = new Array(1);
  const accessor = [wrappedRow()];
  Object.defineProperty(accessor, '0', { get() { throw new Error('must not run'); } });
  const extra = [wrappedRow()] as unknown[] & { extra?: string };
  extra.extra = 'synthetic';
  const symbol = [wrappedRow()];
  Object.defineProperty(symbol, Symbol('synthetic'), { value: true });
  const wrongPrototype = [wrappedRow()];
  Object.setPrototypeOf(wrongPrototype, Object.create(Array.prototype));
  const revoked = Proxy.revocable([wrappedRow()], {});
  revoked.revoke();
  for (const badRows of [null, {}, '[]', sparse, accessor, extra, symbol, wrongPrototype, revoked.proxy]) {
    const result = outcome(badRows);
    assert.deepEqual(result.issues, ['INVALID_ROWS']);
    assert.equal(result.rowsInspected, 0);
    assert.ok(Object.values(result.counts).every((count) => count === 0));
  }
  const tooMany = new Array(1001).fill(null);
  assert.deepEqual(outcome(tooMany).issues, ['ROW_LIMIT_EXCEEDED']);
  assert.equal(outcome([]).rowsInspected, 0);
  assert.deepEqual(outcome(Array.from({ length: 1000 }, () => null)).counts.malformedRows, 1000);
});

test('malformed row, data, company and conids accessors never execute', () => {
  let calls = 0;
  const rowAccessor = {};
  Object.defineProperty(rowAccessor, 'data', { get() { calls += 1; return {}; } });
  const dataAccessor = {};
  Object.defineProperty(dataAccessor, 'company', { get() { calls += 1; return {}; } });
  const companyAccessor = {};
  Object.defineProperty(companyAccessor, 'isin', { get() { calls += 1; return expected.isin; } });
  const conidsAccessor = ['987654321'];
  Object.defineProperty(conidsAccessor, '0', { get() { calls += 1; return '987654321'; } });
  const result = outcome([
    rowAccessor,
    wrappedRow(dataAccessor),
    wrappedRow({ conids: ['987654321'], company: companyAccessor }),
    wrappedRow({ conids: conidsAccessor, company: { isin: expected.isin } }),
  ]);
  assert.equal(calls, 0);
  assert.equal(result.counts.malformedRows, 4);
  assert.equal(result.counts.identityMatchedRows, 0);
});

test('changing array index descriptors remain boundary failures without executing getters', () => {
  let getterCalls = 0;
  const changingDescriptor = (value: unknown): unknown[] => {
    let indexReads = 0;
    return new Proxy([value], {
      getOwnPropertyDescriptor(target, key) {
        if (key === '0' && ++indexReads > 1) {
          return {
            configurable: true,
            enumerable: true,
            get() { getterCalls += 1; return 'synthetic_private_value'; },
          };
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
  };

  const topLevel = outcome(changingDescriptor(wrappedRow()));
  assert.deepEqual(topLevel.issues, ['INVALID_ROWS']);
  assert.equal(topLevel.rowsInspected, 0);
  assert.ok(Object.values(topLevel.counts).every((count) => count === 0));

  const nested = outcome([wrappedRow(row({ conids: changingDescriptor('987654321') }))]);
  assert.deepEqual(nested.issues, ['MALFORMED_ROWS']);
  assert.equal(nested.rowsInspected, 1);
  assert.equal(nested.counts.malformedRows, 1);
  assert.ok(Object.entries(nested.counts).every(([key, count]) => key === 'malformedRows' || count === 0));
  assert.equal(getterCalls, 0);
  assert.equal(JSON.stringify([topLevel, nested]).includes('synthetic_private'), false);
  assert.equal(JSON.stringify([topLevel, nested]).includes('987654321'), false);
});

test('conids accessors remain malformed when extra keys also invalidate the array', () => {
  let getterCalls = 0;
  const extraAccessor = ['987654321'];
  Object.defineProperty(extraAccessor, 'synthetic_private_key', {
    get() { getterCalls += 1; return 'synthetic_private_value'; },
  });
  const indexAccessor = ['987654321'] as string[] & { extra?: string };
  Object.defineProperty(indexAccessor, '0', {
    get() { getterCalls += 1; return '987654321'; },
  });
  indexAccessor.extra = 'synthetic_private_value';
  const extraData = ['987654321'] as string[] & { extra?: string };
  extraData.extra = 'synthetic_private_value';

  const result = outcome([
    wrappedRow(row({ conids: extraAccessor })),
    wrappedRow(row({ conids: indexAccessor })),
    wrappedRow(row({ conids: extraData })),
  ]);

  assert.equal(getterCalls, 0);
  assert.equal(result.rowsInspected, 3);
  assert.deepEqual(result.counts, {
    malformedRows: 2,
    identityMatchedRows: 0,
    identityMismatchedRows: 0,
    identityUnverifiableRows: 1,
    dateRows: 1,
    instantRows: 0,
    unknownDateTypeRows: 0,
    announcementFieldPresentRows: 1,
    announcementFieldAbsentRows: 0,
    watchlistTaggedRows: 0,
  });
  assert.deepEqual(result.issues, ['IDENTITY_UNVERIFIABLE', 'MALFORMED_ROWS']);
  assert.equal(JSON.stringify(result).includes('synthetic_private'), false);
  assert.equal(JSON.stringify(result).includes('987654321'), false);
  assert.equal(
    result.counts.malformedRows + result.counts.identityMatchedRows + result.counts.identityMismatchedRows + result.counts.identityUnverifiableRows,
    result.rowsInspected,
  );
  assert.equal(
    result.counts.dateRows + result.counts.instantRows + result.counts.unknownDateTypeRows,
    result.rowsInspected - result.counts.malformedRows,
  );
  assert.equal(
    result.counts.announcementFieldPresentRows + result.counts.announcementFieldAbsentRows,
    result.rowsInspected - result.counts.malformedRows,
  );
});

test('revoked examined data/company proxies and conids reflection failures are malformed', () => {
  const revokedData = Proxy.revocable({}, {});
  revokedData.revoke();
  const revokedCompany = Proxy.revocable({}, {});
  revokedCompany.revoke();
  const throwingConids = new Proxy({}, { ownKeys() { throw new Error('synthetic conids trap'); } });
  const result = outcome([
    { index_date_type: 'DATE', data: revokedData.proxy },
    { index_date_type: 'DATE', data: { company: revokedCompany.proxy } },
    { index_date_type: 'DATE', data: { company: { isin: expected.isin } }, conids: throwingConids },
  ]);
  assert.equal(result.counts.malformedRows, 3);
  assert.equal(result.counts.identityUnverifiableRows, 0);
});

test('row reflection failures are malformed and proxy trap text is not returned', () => {
  const rowProxy = new Proxy({}, { ownKeys() { throw new Error('synthetic trap secret'); } });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const result = outcome([rowProxy, revoked.proxy]);
  assert.equal(result.counts.malformedRows, 2);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('row identity, structure, announcement field and output bounds are conservative', () => {
  const tooManyKeys = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`k${index}`, 'synthetic']));
  const tooManyConids = Array.from({ length: 33 }, (_, index) => String(index + 1));
  const duplicateConids = ['987654321', '987654321'];
  const invalidIsin = 'ZZABCDEF123x';
  const secret = 'synthetic-secret-value';
  const result = outcome([
    wrappedRow({ conids: tooManyConids, company: { isin: expected.isin } }),
    wrappedRow({ conids: duplicateConids, company: { isin: expected.isin } }),
    wrappedRow({ conids: ['987654321'], company: { isin: invalidIsin }, announce_empty: '' }),
    wrappedRow({ ...tooManyKeys }),
    wrappedRow({ conids: ['987654321'], company: { isin: expected.isin }, tooltip: secret, announce_good: '  yes  ' }),
  ]);
  assert.equal(result.counts.identityMatchedRows, 1);
  assert.equal(result.counts.identityUnverifiableRows, 3);
  assert.equal(result.counts.malformedRows, 1);
  assert.equal(result.counts.announcementFieldPresentRows, 1);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes(expected.isin), false);
  assert.equal(JSON.stringify(result).includes('987654321'), false);
});

test('row arrays and records are not mutated and all counter equations conserve rows', () => {
  const input = [
    wrappedRow(row({ conids: ['987654321', '4'] })),
    wrappedRow(row({ conids: ['9'], announce_note: 'synthetic' }), { index_date_type: 'INSTANT' }),
    wrappedRow({ conids: ['bad'], company: { isin: expected.isin } }, { index_date_type: 'UNKNOWN' }),
    null,
  ];
  const before = input.map((entry) => entry);
  const firstData = (input[0] as { data: unknown }).data;
  const beforeKeys = Reflect.ownKeys(firstData as object);
  const result = outcome(input);
  assert.deepEqual(input, before);
  assert.deepEqual(Reflect.ownKeys(firstData as object), beforeKeys);
  assert.equal(
    result.counts.malformedRows + result.counts.identityMatchedRows + result.counts.identityMismatchedRows + result.counts.identityUnverifiableRows,
    result.rowsInspected,
  );
  assert.equal(
    result.counts.dateRows + result.counts.instantRows + result.counts.unknownDateTypeRows,
    result.rowsInspected - result.counts.malformedRows,
  );
  assert.equal(
    result.counts.announcementFieldPresentRows + result.counts.announcementFieldAbsentRows,
    result.rowsInspected - result.counts.malformedRows,
  );
});
