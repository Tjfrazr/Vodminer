// Jest config for an ESM-only repo (package.json "type": "module").
// Run with: `npm test` — which invokes jest under --experimental-vm-modules.
export default {
  testEnvironment: 'node',
  transform: {},
  testMatch: ['**/tests/**/*.test.js'],
  moduleFileExtensions: ['js', 'mjs'],
  extensionsToTreatAsEsm: [],
  // Don't auto-clear/reset mocks globally — individual tests manage their own state
  // (some need module caches preserved across assertions in the same `it`).
  clearMocks: false,
  testPathIgnorePatterns: ['/node_modules/'],
};
