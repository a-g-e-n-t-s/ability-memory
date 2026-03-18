// import-export.mjs - ES Module wrapper for CommonJS import-export module
import importExportRequire from './import-export.cjs';

// The CommonJS module exports the class directly
const ImportExportManager = importExportRequire;

// Re-export as proper ES module
export { ImportExportManager };
export default ImportExportManager;