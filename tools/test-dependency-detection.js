/**
 * Verifies prerequisite detection against the real machine.
 * Run with:  node tools/test-dependency-detection.js
 */
const { detectSystemDependencies, findMissingDependencies } = require('../src/backend/aiInstaller');

console.log('\nDetected on this machine:');
const detected = detectSystemDependencies();
for (const [key, value] of Object.entries(detected)) {
  console.log(`  ${value ? 'YES' : ' no'}  ${key}`);
}

console.log('\nMissing prerequisites (nothing bundled):');
const missing = findMissingDependencies([]);
if (missing.length === 0) {
  console.log('  (none — machine already has every runtime)');
} else {
  for (const entry of missing) {
    console.log(`  - ${entry.label}`);
    console.log(`      ${entry.url}`);
  }
}

console.log('\nBundled-copy preference:');
const bundled = findMissingDependencies(['C:\\Games\\vcredist_x64.exe', 'C:\\Games\\dxsetup.exe']);
for (const entry of bundled) {
  const usedBundle = entry.bundledPath ? `bundled -> ${entry.bundledPath}` : 'download';
  console.log(`  - ${entry.label}: ${usedBundle}`);
}
console.log();
