/**
 * Top-level db barrel — handy for `import { db, hsCodes } from '../db/index.js'`
 * shorthand. Existing code paths continue to import from `./client.js` and
 * `./schema.js` directly; both styles are supported.
 */
export { getPool, db, closeDb } from './client.js';
export * from './schema.js';
