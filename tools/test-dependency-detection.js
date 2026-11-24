/**
 * Verifies prerequisite detection against the real machine.
 * Run with:  node tools/test-dependency-detection.js
 */
const { detectSystemDependencies, findMissingDependencies } = require('../src/backend/aiInstaller');

const allMissing = {
  'Visual C++ 2015-2022 Redistributable (x64)': false,
  'Visual C++ 2015-2022 Redistributable (x86)': false,
  'DirectX End-User Runtime (June 2010)': false,
  '.NET Framework 4.8': false,
};
if (findMissingDependencies([], allMissing).length !== 0) {
  throw new Error('Prerequisites not present in the download must not be installed automatically.');
}

const bundledMissing = findMissingDependencies([
  'C:\\Games\\VC_redist.x64.exe',
  'C:\\Games\\ndp48-x86.exe',
], allMissing);
if (bundledMissing.length !== 2
  || !bundledMissing.some((entry) => entry.id === 'vcredist_x64')
  || !bundledMissing.some((entry) => entry.id === 'dotnet48')) {
  throw new Error('Only bundled prerequisites that are missing should be selected.');
}

console.log('\nDetected on this machine:');
const detected = detectSystemDependencies();
for (const [key, value] of Object.entries(detected)) {
  console.log(`  ${value ? 'YES' : ' no'}  ${key}`);
}

console.log('\nBundled prerequisites that are missing:');
const missing = findMissingDependencies([]);
if (missing.length === 0) {
  console.log('  (none — no bundled prerequisite is missing)');
} else {
  for (const entry of missing) {
    console.log(`  - ${entry.label}: ${entry.bundledPath}`);
  }
}

console.log('\nBundled-copy preference:');
const bundled = findMissingDependencies(['C:\\Games\\vcredist_x64.exe', 'C:\\Games\\dxsetup.exe']);
for (const entry of bundled) {
  console.log(`  - ${entry.label}: bundled -> ${entry.bundledPath}`);
}
console.log();
