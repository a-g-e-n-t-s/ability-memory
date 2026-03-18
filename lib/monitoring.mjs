// monitoring.mjs - ES Module wrapper for CommonJS monitoring module
import monitoringRequire from './monitoring.cjs';

// The CommonJS module exports the class directly
const MonitoringManager = monitoringRequire;

// Re-export as proper ES module
export { MonitoringManager };
export default MonitoringManager;