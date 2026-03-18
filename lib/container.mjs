// container.mjs - ES Module wrapper for CommonJS container module
import containerRequire from './container.cjs';

// The CommonJS module exports the class directly
const ContainerManager = containerRequire;

// Re-export as proper ES module
export { ContainerManager };
export default ContainerManager;