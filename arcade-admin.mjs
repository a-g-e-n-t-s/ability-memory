// arcade-admin.mjs - ES Module wrapper for CommonJS library
import arcadeAdminRequire from './arcade-admin.js';

// The CommonJS module exports the class directly
const ArcadeAdmin = arcadeAdminRequire;

// Re-export as proper ES module
export { ArcadeAdmin };
export default ArcadeAdmin;