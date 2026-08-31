/**
 * Test preload (bunfig.toml [test].preload): installs a fake IndexedDB
 * implementation before any module graph evaluates, because Dexie captures
 * the `indexedDB`/`IDBKeyRange` globals at module evaluation time.
 */
import "fake-indexeddb/auto";
