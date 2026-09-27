import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BloomierFilter, buildBloomierFilter } from '../src/index.js';

/**
 * Deterministic helper: build a small integer-valued dictionary where values
 * fit in `m` bits, then assert every key round-trips.
 */
function integerEntries(n, m) {
  const out = new Map();
  for (let i = 0; i < n; i++) {
    // Value stays within m bits so encodeValue does not throw.
    out.set(`key-${i}`, i % Math.max(1, 2 ** m - 1));
  }
  return out;
}

test('round-trips integer values for a small static dictionary', () => {
  const entries = integerEntries(50, 8);
  const bf = BloomierFilter.from(entries, { m: 8, k: 3 });
  assert.equal(bf.size, 50);
  for (const [key, value] of entries) {
    assert.equal(bf.has(key), true);
    assert.equal(bf.get(key), value);
  }
});

test('non-member keys return undefined and do not throw', () => {
  const bf = BloomierFilter.from(new Map([['a', 1], ['b', 2]]), { m: 4 });
  assert.equal(bf.has('nope'), false);
  assert.equal(bf.get('nope'), undefined);
});

test('string-valued dictionary returns the original string', () => {
  const entries = new Map([['alpha', 'red'], ['beta', 'green'], ['gamma', 'blue']]);
  const bf = BloomierFilter.from(entries, { m: 16 });
  assert.equal(bf.get('alpha'), 'red');
  assert.equal(bf.get('gamma'), 'blue');
  assert.equal(bf.get('missing'), undefined);
});

test('accepts plain object and array-of-pairs input', () => {
  const obj = { x: 10, y: 20 };
  const arr = [['x', 10], ['y', 20]];
  const a = BloomierFilter.from(obj, { m: 8 });
  const b = BloomierFilter.from(arr, { m: 8 });
  assert.equal(a.get('x'), 10);
  assert.equal(b.get('y'), 20);
});

test('validate returns true for a freshly built filter', () => {
  const bf = BloomierFilter.from(new Map([['k1', 3], ['k2', 7]]), { m: 8 });
  assert.equal(bf.validate(), true);
});

test('validate returns false after a table cell is corrupted', () => {
  const payload = buildBloomierFilter(new Map([['k1', 3], ['k2', 7], ['k3', 1]]), { m: 8 });
  // Flip a bit in the first cell; at least one member should fail to reproduce.
  payload.table[0] ^= 1;
  const bf = new BloomierFilter(payload);
  assert.equal(bf.validate(), false);
});

test('integer value outside m-bit range is rejected at build time', () => {
  assert.throws(
    () => BloomierFilter.from(new Map([['k', 256]]), { m: 8 }),
    /out of range/
  );
});

test('negative integer value is rejected', () => {
  assert.throws(
    () => BloomierFilter.from(new Map([['k', -1]]), { m: 8 }),
    /out of range/
  );
});

test('invalid m throws', () => {
  assert.throws(
    () => BloomierFilter.from(new Map([['k', 1]]), { m: 0 }),
    /m must be an integer/
  );
});

test('invalid k throws', () => {
  assert.throws(
    () => BloomierFilter.from(new Map([['k', 1]]), { k: 1 }),
    /k must be an integer/
  );
});

test('different seeds produce different table contents but equivalent lookups', () => {
  const entries = integerEntries(20, 8);
  const a = buildBloomierFilter(entries, { m: 8, seed: 1 });
  const b = buildBloomierFilter(entries, { m: 8, seed: 2 });
  // Tables differ because hash assignments differ.
  let differ = false;
  for (let i = 0; i < a.table.length; i++) {
    if (a.table[i] !== b.table[i]) { differ = true; break; }
  }
  assert.equal(differ, true);
  // But both round-trip every member.
  for (const [key, value] of entries) {
    assert.equal(new BloomierFilter(a).get(key), value);
    assert.equal(new BloomierFilter(b).get(key), value);
  }
});

test('large-ish static dictionary round-trips', () => {
  const entries = integerEntries(500, 16);
  const bf = BloomierFilter.from(entries, { m: 16, k: 3 });
  let ok = 0;
  for (const [key, value] of entries) {
    if (bf.get(key) === value) ok++;
  }
  assert.equal(ok, entries.size);
});

test('explicit tableSize smaller than k is rejected', () => {
  assert.throws(
    () => buildBloomierFilter(new Map([['k', 1]]), { k: 3, tableSize: 2 }),
    /tableSize/
  );
});

test('payload can be reconstructed from its fields', () => {
  const entries = new Map([['a', 5], ['b', 9], ['c', 2]]);
  const built = buildBloomierFilter(entries, { m: 8 });
  // Simulate a serialization round-trip using only exported-facing fields.
  const revived = new BloomierFilter({
    table: new Uint32Array(built.table),
    k: built.k,
    m: built.m,
    seed: built.seed,
    size: built.size,
    members: new Set(built.members),
    values: new Map(built.values),
  });
  assert.equal(revived.get('a'), 5);
  assert.equal(revived.get('c'), 2);
  assert.equal(revived.validate(), true);
});

test('boolean values are rejected as unsupported', () => {
  assert.throws(
    () => BloomierFilter.from(new Map([['k', true]]), { m: 8 }),
    /unsupported value type/
  );
});

test('empty dictionary builds and queries cleanly', () => {
  const bf = BloomierFilter.from(new Map(), { m: 8 });
  assert.equal(bf.size, 0);
  assert.equal(bf.has('anything'), false);
  assert.equal(bf.get('anything'), undefined);
  assert.equal(bf.validate(), true);
});

test('k=2 still round-trips members', () => {
  const entries = integerEntries(30, 8);
  const bf = BloomierFilter.from(entries, { m: 8, k: 2 });
  for (const [key, value] of entries) {
    assert.equal(bf.get(key), value);
  }
});
