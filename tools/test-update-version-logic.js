// Verifies the updater's version comparison and skip logic.
//
// The bug this guards against: a brand new install of the app popped the
// "Universal Freebie 1.0.17 is ready" dialog even though the user was already
// running that exact build, because the release check never compared versions.
// These assertions pin the comparison down, including the parseVersion and
// isNewerVersion helpers extracted from electron/main.js.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  if (actual === expected) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL  ${label}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`);
  }
}

// Pull the two pure helpers straight out of the main process source so this
// test can never drift from the code that actually ships.
const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');

// Walks braces from the function's opening brace so a body containing nested
// blocks is captured correctly, and tolerates either LF or CRLF line endings.
function extractHelper(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`could not find ${name} in electron/main.js`);

  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`could not find the end of ${name}`);
}

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(`${extractHelper('parseVersion')}\n${extractHelper('isNewerVersion')}`, sandbox);
const { parseVersion, isNewerVersion } = sandbox;

// ---------------------------------------------------------------- parseVersion
check('parseVersion plain', JSON.stringify(parseVersion('1.0.17')), '[1,0,17]');
check('parseVersion leading v', JSON.stringify(parseVersion('v1.0.17')), '[1,0,17]');
check('parseVersion uppercase V', JSON.stringify(parseVersion('V1.0.17')), '[1,0,17]');
check('parseVersion with whitespace', JSON.stringify(parseVersion('  1.2.3 ')), '[1,2,3]');
check('parseVersion prerelease', JSON.stringify(parseVersion('1.0.17-beta.2')), '[1,0,17]');
check('parseVersion double digit', JSON.stringify(parseVersion('1.10.9')), '[1,10,9]');
check('parseVersion missing patch', parseVersion('1.0'), null);
check('parseVersion empty', parseVersion(''), null);
check('parseVersion garbage', parseVersion('latest'), null);
check('parseVersion undefined', parseVersion(undefined), null);

// -------------------------------------------------------------- isNewerVersion
// The exact case from the bug: installed build matches the published tag.
check('same version is not newer', isNewerVersion('1.0.17', '1.0.17'), false);
check('same version with v prefix is not newer', isNewerVersion('v1.0.17', '1.0.17'), false);
check('same version with r prefix', isNewerVersion('1.0.17', 'v1.0.17'), false);

check('newer patch is newer', isNewerVersion('1.0.18', '1.0.17'), true);
check('older patch is not newer', isNewerVersion('1.0.16', '1.0.17'), false);
check('newer minor is newer', isNewerVersion('1.1.0', '1.0.17'), true);
check('older minor is not newer', isNewerVersion('1.0.99', '1.1.0'), false);
check('newer major is newer', isNewerVersion('2.0.0', '1.9.9'), true);
check('older major is not newer', isNewerVersion('0.9.0', '1.0.0'), false);
check('numeric not lexical 1.0.9 < 1.0.10', isNewerVersion('1.0.9', '1.0.10'), false);
check('numeric not lexical 1.0.10 > 1.0.9', isNewerVersion('1.0.10', '1.0.9'), true);
check('numeric minor 1.10.0 > 1.9.0', isNewerVersion('1.10.0', '1.9.0'), true);

// An unreadable tag is surfaced rather than silently hidden.
check('unparseable candidate treated as newer', isNewerVersion('latest', '1.0.17'), true);
check('unparseable current treated as newer', isNewerVersion('1.0.17', 'latest'), true);

// ------------------------------------------------------------------ skip rules
// Mirrors isUpdateSkipped(): a dismissed version suppresses the dialog only
// while the offered release is that exact same version. A newer release is
// offered again, which is the whole point of storing the version.
function isSkipped(skipped, offered) {
  const a = parseVersion(skipped);
  const b = parseVersion(offered);
  if (!a || !b) return false;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

check('no skip means not skipped', isSkipped(null, '1.0.17'), false);
check('skipping the offered version suppresses it', isSkipped('1.0.17', '1.0.17'), true);
check('skip tolerates a v prefix', isSkipped('v1.0.17', '1.0.17'), true);
check('a newer release is offered again', isSkipped('1.0.17', '1.0.18'), false);
check('a different older release is not suppressed', isSkipped('1.0.17', '1.0.16'), false);
check('minor bump clears the skip', isSkipped('1.0.17', '1.1.0'), false);
check('unparseable skip is ignored', isSkipped('latest', '1.0.17'), false);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('UPDATE_LOGIC_EXIT_1');
  process.exitCode = 1;
} else {
  console.log('UPDATE_LOGIC_EXIT_0');
}
