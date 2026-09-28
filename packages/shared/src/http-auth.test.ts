import test from 'node:test';
import assert from 'node:assert/strict';
import { bearerAuthorized, secretsEqual } from './http-auth.js';

test('secret comparison rejects length XOR, padding and UTF-8 collisions', () => {
  for (const [given, expected] of [['a'.repeat(31), 'a'.repeat(31) + '?'], ['a', 'a\0'], ['é', 'e'], ['', ''], ['é', 'é\0']]) {
    assert.equal(secretsEqual(given, expected), false);
  }
  assert.equal(secretsEqual('é'.repeat(32), 'é'.repeat(32)), true);
});
test('Bearer credentials are singular, nonempty and exact', () => {
  for (const value of [undefined, '', ['Bearer correct'], 'Basic correct', 'Bearer wrong', 'Bearer correct, Bearer correct', 'Bearer correct ']) {
    assert.equal(bearerAuthorized(value, 'correct'), false);
  }
  assert.equal(bearerAuthorized('Bearer correct', 'correct'), true);
  assert.equal(bearerAuthorized('Bearer correct', ''), false);
});
