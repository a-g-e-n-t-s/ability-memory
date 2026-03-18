// database.mjs - ES Module wrapper for CommonJS database module
import databaseRequire from './database.cjs';

// The CommonJS module exports the class directly
const DatabaseManager = databaseRequire;

// Re-export as proper ES module
export { DatabaseManager };
export default DatabaseManager;