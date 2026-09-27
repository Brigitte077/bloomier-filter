/**
 * Bloomier Filter — ESM entry point.
 *
 * Exports the public surface of the library: the {@link BloomierFilter}
 * class for querying a built filter, and {@link buildBloomierFilter} for
 * constructing one from a static key→value dictionary.
 */

export { BloomierFilter, buildBloomierFilter } from './core.js';
