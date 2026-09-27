# Bloomier Filter

A small, dependency-free Bloomier filter: associate a short value with every key in a static dictionary and look it up in O(k) time with no false positives on membership.

```js
import { BloomierFilter } from 'bloomier-filter';

const bf = BloomierFilter.from(
  new Map([['alice', 7], ['bob', 3], ['carol', 12]]),
  { m: 8, k: 3 }
);

bf.get('alice');   // 7
bf.has('dave');    // false
bf.get('dave');    // undefined
```

## Exports

- `buildBloomierFilter(entries, options?)` — builds and returns the raw filter payload (`{ table, k, m, seed, size, members, values }`).
- `BloomierFilter` — queryable wrapper. Construct with a payload, or use the static `BloomierFilter.from(entries, options?)`.

`BloomierFilter` instances expose: `has(key)`, `get(key)`, `size`, `validate()`, and the raw fields `table`, `k`, `m`, `seed`.

## Why this exists

The problem: you have a fixed, known-at-build-time set of keys and you want to recover a small value per key without storing a full hash map. A Bloomier filter stores `k` cells per key and XORs them on lookup, so storage is ~1.5× a Bloom filter rather than the full key+value set.

Trade-off we made: to guarantee "no false positives" on membership, we keep the explicit key set in memory alongside the XOR table. The XOR table alone cannot distinguish a non-member from a member — it returns *some* m-bit value for any input. Storing the member set costs O(n) but makes `has` and `get` honest. If you only needed the XOR behavior you could drop the set; we chose correctness of the returned value over the last word in compactness, because the brief asked for no false positives and for a real dictionary-style `get`.

Values may be small non-negative integers (must fit in `m` bits) or strings. Integer values are stored directly and returned as numbers. String values are hashed to an m-bit fingerprint in the table; the original strings are retained in the member map so `get` returns them exactly. Keeping the strings is the same trade-off as keeping the keys: the fingerprint is not invertible, and returning garbage to save a few hundred bytes would defeat the point.

## The awkward edge

Construction can fail. The build algorithm peels keys off one at a time, assigning a cell to satisfy each. If the table is too small or the hash assignment unlucky, a clique of keys shares all their cells and peeling stalls. When this happens `buildBloomierFilter` **throws** rather than producing a silently broken filter. Retry with a larger `tableSize` (default is `ceil(1.5 * n * k)`) or a different `seed`.
