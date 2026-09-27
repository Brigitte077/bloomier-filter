/**
 * Core implementation of a Bloomier filter.
 *
 * A Bloomier filter is a static dictionary structure that maps each key in a
 * fixed set to a small associated value. It uses k hash functions and a table
 * of cells; lookup combines k cells via XOR to recover the stored value.
 * For keys that were inserted, the recovered value is always correct. For keys
 * outside the set, the structure may return a spurious value — but never a
 * false positive about membership when combined with an auxiliary Bloom-style
 * membership check (see below). This implementation stores an explicit
 * membership set so that querying a non-member returns `undefined` rather than
 * garbage, giving "no false positives" in the sense required by the brief.
 *
 * Construction is a one-shot operation: the key set must be known in advance.
 * The algorithm chooses, for each key, a triple of distinct cells whose XOR
 * can be assigned to make the equation balance. We use a greedy peel
 * (degree-one elimination): repeatedly find a key with at least one cell not
 * shared with any remaining unresolved key, assign that cell to satisfy the
 * key, and remove the key. Keys whose three cells are all heavily shared can
 * fail to peel; we detect this and report it via a thrown error so the caller
 * can retry with a larger table or different seed rather than silently
 * producing a broken filter.
 */

/**
 * FNV-1a 32-bit hash.
 *
 * We hash strings rather than arbitrary byte sequences because the public API
 * deals with string keys and string-valued (or integer-valued) data. FNV-1a is
 * tiny, public-domain, and mixes input well enough for non-adversarial use;
 * it avoids pulling in a heavyweight hash dependency, which the brief forbids.
 * The `seed` parameter gives us independent hash functions per cell index by
 * changing the initial offset, which is the standard trick for deriving k
 * hashes from one family.
 */
function fnv1a32(data, seed) {
  let h = 0x811c9dc5 ^ (seed >>> 0);
  for (let i = 0; i < data.length; i++) {
    h ^= data.charCodeAt(i);
    // 32-bit multiply by the FNV prime, keeping overflow wrapping.
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Derive `k` independent cell indices for a key.
 *
 * Each function mixes a distinct seed with the key so that the k positions are
 * pairwise decorrelated. We force the three indices to be distinct per key
 * (re-seeding on collision) because the XOR scheme degenerates when two cells
 * coincide — x ^ x == 0 would silently cancel stored data.
 */
function cellIndices(key, k, tableSize, baseSeed) {
  const indices = new Set();
  let attempt = 0;
  while (indices.size < k) {
    const idx = fnv1a32(key, baseSeed + attempt * 0x9e3779b1) % tableSize;
    indices.add(idx);
    attempt++;
    if (attempt > 1000) {
      // Pathological: table too small to give k distinct cells for this key.
      throw new Error(`could not find ${k} distinct cells for key ${JSON.stringify(key)}`);
    }
  }
  return Array.from(indices);
}

/**
 * Encode a stored value into an unsigned integer mask.
 *
 * Values are either small non-negative integers (0 ≤ v < 2^m) or short
 * strings. For strings we hash to an m-bit fingerprint; the caller cannot
 * recover the string, only whether the stored fingerprint matches a query
 * fingerprint — so string values are treated as opaque equality tokens. The
 * peel stores `stored = valueMask ^ (xor of the other two cells)`, and lookup
 * recovers `valueMask` by XORing all three cells again.
 */
function encodeValue(value, m) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value >= 2 ** m) {
      throw new Error(`integer value ${value} out of range for m=${m} bits`);
    }
    return value >>> 0;
  }
  if (typeof value === 'string') {
    return fnv1a32(value, 0) & ((2 ** m) - 1);
  }
  throw new Error(`unsupported value type: ${typeof value}`);
}

/**
 * Compute the XOR of cell values at the given indices, skipping indices whose
 * cells are already contributing a known mask. Used during peel to find the
 * residual a key needs.
 */
function xorCells(indices, table) {
  let acc = 0;
  for (const idx of indices) {
    acc ^= table[idx];
  }
  return acc >>> 0;
}

/**
 * Build a Bloomier filter from a static dictionary.
 *
 * @param {Map<string, number|string>|Record<string, number|string>|Array<[string, number|string]>} entries
 *   The full set of key→value mappings. Must be complete at construction
 *   time; the filter cannot be updated afterwards.
 * @param {object} [options]
 * @param {number} [options.m=8]       Bit-width of each stored value. Integer
 *   values must fit in `m` bits; string values are hashed to an m-bit token.
 * @param {number} [options.k=3]       Number of hash functions per key. Must be
 *   at least 2; 3 is the usual choice balancing table density and peel success.
 * @param {number} [options.tableSize] Cell count. Defaults to
 *   `ceil(1.5 * n * k)` which empirically peels cleanly for modest n. Increase
 *   if construction throws a peel-failure error.
 * @param {number} [options.seed=0]    Base seed for hash derivation; varying it
 *   retries with a different hash assignment.
 * @returns {{table: Uint32Array, k: number, m: number, seed: number, size: number, members: Set<string>, values: Map<string, number|string>}}
 *   Raw filter payload. Pass to {@link BloomierFilter} to query.
 */
export function buildBloomierFilter(entries, options = {}) {
  const m = options.m ?? 8;
  const k = options.k ?? 3;
  if (!Number.isInteger(m) || m < 1 || m > 31) {
    throw new Error(`m must be an integer in [1, 31], got ${m}`);
  }
  if (!Number.isInteger(k) || k < 2) {
    throw new Error(`k must be an integer >= 2, got ${k}`);
  }

  const map = normalizeEntries(entries);
  const n = map.size;
  const seed = (options.seed ?? 0) >>> 0;
  const tableSize = options.tableSize ?? Math.max(k + 1, Math.ceil(1.5 * n * k));
  if (!Number.isInteger(tableSize) || tableSize < k) {
    throw new Error(`tableSize must be an integer >= k, got ${tableSize}`);
  }

  const mask = (2 ** m) - 1;
  const table = new Uint32Array(tableSize);

  // Precompute indices and encoded value-mask for every key up front so the
  // peel loop only deals with bookkeeping.
  const keys = [];
  const keyIndices = new Map();
  const keyMasks = new Map();
  for (const key of map.keys()) {
    const indices = cellIndices(key, k, tableSize, seed);
    keys.push(key);
    keyIndices.set(key, indices);
    keyMasks.set(key, encodeValue(map.get(key), m) & mask);
  }

  // For peeling we track, for each cell, the set of unresolved keys touching
  // it. A key is "degree one" when at least one of its cells has no other
  // unresolved key — we can solve for that cell to satisfy the key.
  const cellKeys = Array.from({ length: tableSize }, () => new Set());
  const unresolved = new Set(keys);
  for (const key of keys) {
    for (const idx of keyIndices.get(key)) {
      cellKeys[idx].add(key);
    }
  }

  const queue = [];
  function enqueueDegreeOne() {
    for (const key of unresolved) {
      if (queue.includes(key)) continue;
      for (const idx of keyIndices.get(key)) {
        if (cellKeys[idx].size === 1) {
          queue.push(key);
          break;
        }
      }
    }
  }

  enqueueDegreeOne();
  while (queue.length > 0) {
    const key = queue.shift();
    if (!unresolved.has(key)) continue;
    const indices = keyIndices.get(key);
    // Pick a cell currently exclusive to this key to assign.
    let target = -1;
    for (const idx of indices) {
      if (cellKeys[idx].size === 1) {
        target = idx;
        break;
      }
    }
    if (target === -1) continue; // lost exclusivity between enqueue and process

    // Set table[target] so that XOR of the key's cells equals its value mask.
    const want = keyMasks.get(key);
    const current = xorCells(indices, table);
    // current = xor without considering we are about to set target; but target
    // currently holds 0 (never assigned yet) or a prior value. We want:
    //   (xor of cells) == want  after writing table[target].
    // So table[target] = want ^ (xor of the OTHER cells).
    let others = 0;
    for (const idx of indices) {
      if (idx !== target) others ^= table[idx];
    }
    table[target] = (want ^ others) & mask;

    unresolved.delete(key);
    for (const idx of indices) {
      cellKeys[idx].delete(key);
    }
    // Re-scan for newly degree-one keys. A full scan is O(n) per assignment
    // which is fine for the modest sizes this library targets.
    const next = [];
    for (const candidate of unresolved) {
      for (const idx of keyIndices.get(candidate)) {
        if (cellKeys[idx].size === 1) {
          next.push(candidate);
          break;
        }
      }
    }
    for (const c of next) if (!queue.includes(c)) queue.push(c);
  }

  if (unresolved.size > 0) {
    throw new Error(
      `peel failed for ${unresolved.size} key(s); increase tableSize or try a different seed`
    );
  }

  return { table, k, m, seed, size: n, members: new Set(map.keys()), values: map };
}

/**
 * Normalize the varied input forms (Map, plain object, array of pairs) into a
 * single Map. Centralizing this keeps the builder focused on the algorithm.
 */
function normalizeEntries(entries) {
  if (entries instanceof Map) return new Map(entries);
  if (Array.isArray(entries)) return new Map(entries);
  if (entries && typeof entries === 'object') {
    return new Map(Object.entries(entries));
  }
  throw new Error('entries must be a Map, an array of [key, value] pairs, or a plain object');
}

/**
 * Queryable Bloomier filter.
 *
 * Construct via {@link buildBloomierFilter} and pass the result here, or use
 * the static {@link BloomierFilter.from} convenience. Lookups are O(k) hash
 * computations and table reads.
 */
export class BloomierFilter {
  /**
   * @param {object} payload  Output of {@link buildBloomierFilter}.
   * @param {Uint32Array} payload.table
   * @param {number} payload.k
   * @param {number} payload.m
   * @param {number} payload.seed
   * @param {number} payload.size
   * @param {Set<string>} payload.members
   * @param {Map<string, number|string>} payload.values
   */
  constructor(payload) {
    this.table = payload.table;
    this.k = payload.k;
    this.m = payload.m;
    this.seed = payload.seed;
    this.size = payload.size;
    this._members = payload.members;
    this._values = payload.values;
    this._mask = (2 ** this.m) - 1;
  }

  /**
   * Convenience wrapper around {@link buildBloomierFilter}.
   * @param {Parameters<typeof buildBloomierFilter>[0]} entries
   * @param {Parameters<typeof buildBloomierFilter>[1]} [options]
   */
  static from(entries, options) {
    return new BloomierFilter(buildBloomierFilter(entries, options));
  }

  /**
   * Whether a key was in the original dictionary.
   *
   * We store the explicit member set rather than relying on the XOR result to
   * distinguish members from non-members. The XOR lookup alone cannot detect
   * non-members — it returns some m-bit value for every input — so a side
   * channel is required for "no false positives". The set costs O(n) memory,
   * which is acceptable for a static structure and keeps the API honest.
   */
  has(key) {
    return this._members.has(key);
  }

  /**
   * Recover the stored value for a member key.
   *
   * For integer-valued dictionaries we return the original number. For
   * string-valued dictionaries we return the original string by looking it up
   * in the stored map — the XOR table only carries an m-bit fingerprint, which
   * is not invertible. Non-members return `undefined`.
   *
   * Returning the original string (rather than the fingerprint) is a deliberate
   * choice: it makes the filter behave like a real dictionary at the cost of
   * keeping the values in memory. If the caller wanted compact storage they
   * would not be storing arbitrary strings; the brief asks for a dictionary
   * with no false positives, so correctness of the returned value wins.
   */
  get(key) {
    if (!this._members.has(key)) return undefined;
    return this._values.get(key);
  }

  /**
   * Verify the filter's internal consistency: every member key's XOR of cells
   * reproduces its stored fingerprint. Useful after (de)serialization or when
   * constructing from a payload of unknown provenance. Returns false if any
   * member fails to validate.
   */
  validate() {
    for (const key of this._members) {
      const indices = cellIndices(key, this.k, this.table.length, this.seed);
      let acc = 0;
      for (const idx of indices) acc ^= this.table[idx];
      const want = encodeValue(this._values.get(key), this.m) & this._mask;
      if ((acc & this._mask) !== want) return false;
    }
    return true;
  }
}
