#!/usr/bin/env node
/**
 * Regression tests for the download progress meter.
 *
 * Bug: the meter jumped straight to 100% the instant a transfer started.
 * Two independent causes, both covered here:
 *
 *  1. Every progress path (chunked HTTP, single-thread HTTP, torrent and the
 *     Electron will-download intercept) only called _emitProgress() from
 *     inside a "sample the speed at most once a second" branch. A transfer
 *     that finished inside that first second therefore never emitted
 *     anything at all, so the UI sat at 0% and then snapped to 100%.
 *
 *  2. The Electron intercept read item.getTotalBytes() exactly once, while
 *     building the item. Electron reports 0 (or -1) for an unknown size at
 *     'will-download' time, so totalBytes stayed 0 for the whole transfer,
 *     the percentage was never computed, and the bar only ever showed 100%
 *     because _markCompleted() forces it.
 *
 * These tests assert the source contains the fixes, mirroring the style of
 * tools/test-update-version-logic.js.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'backend', 'downloader.js');
const source = fs.readFileSync(SRC, 'utf8');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition) {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL ${name}`);
  }
}

console.log('download progress meter regression tests\n');

// ---------------------------------------------------------------------------
// 1. First-emission guarantee (the "snaps to 100" bug)
// ---------------------------------------------------------------------------
console.log('# first emission is never swallowed by the speed throttle');

/** Slice the source from `start` up to the next occurrence of `end`. */
function sliceBetween(start, end, from = 0) {
  const a = source.indexOf(start, from);
  if (a === -1) return '';
  const b = source.indexOf(end, a + start.length);
  return source.slice(a, b === -1 ? source.length : b);
}

const firstEmitGuards = source.match(/!emittedOnce/g) || [];
const firstEmitInits = source.match(/let emittedOnce = false;/g) || [];
check(
  'all four throttled progress paths have a first-emission fallback',
  firstEmitGuards.length === 4
);
check(
  'each progress path initialises its own first-emission flag',
  firstEmitInits.length === 4
);
check(
  'the first emission sets the flag before emitting',
  /if \(!emittedOnce\) \{\s*\n(?:\s*\/\/[^\n]*\n)*\s*emittedOnce = true;/.test(source)
);

// The chunked path and the single-threaded path must both emit immediately.
const chunkedUpdate = source.match(/const updateProgress = \(\) => \{[\s\S]*?\n {6}\};/);
check('the chunked downloader has a throttled progress reporter', !!chunkedUpdate);
check(
  'the chunked downloader emits its first chunk immediately',
  !!chunkedUpdate && /!emittedOnce/.test(chunkedUpdate[0])
);

const singleThread = sliceBetween('async _singleThreadDownload', '\n  startTorrentDownload');
check('the single-threaded downloader exists', singleThread.length > 0);
check(
  'the single-threaded downloader emits its first chunk immediately',
  /!emittedOnce/.test(singleThread)
);

const torrentHandler = source.match(/torrent\.on\('download'[\s\S]*?\n {6}\}\);/);
check('the torrent download handler exists', !!torrentHandler);
check(
  'the torrent download handler emits its first chunk immediately',
  !!torrentHandler && /!emittedOnce/.test(torrentHandler[0])
);

const electronHandler = sliceBetween("item.on('updated'", "\n    item.once('done'");
check('the Electron will-download handler exists', electronHandler.length > 0);
check(
  'the Electron will-download handler emits its first tick immediately',
  /!emittedOnce/.test(electronHandler)
);

// ---------------------------------------------------------------------------
// 2. Live total-size refresh (the "total unknown at will-download" bug)
// ---------------------------------------------------------------------------
console.log('\n# Electron total size is re-read once headers are parsed');

const intercept = source.match(/interceptElectronDownload\(item\)\s*\{[\s\S]*$/);
check('interceptElectronDownload exists', !!intercept);
check(
  'a safe accessor wrapper guards the throwing Electron getters',
  !!intercept && /const safeNum = \(fn, fallback = 0\)/.test(intercept[0])
);
check(
  'negative sentinels from getTotalBytes() are treated as unknown',
  !!intercept && /value < 0\) return fallback/.test(intercept[0])
);
check(
  'the total size is re-read while the transfer is running',
  !!intercept && /const latestTotal = safeNum\(\(\) => item\.getTotalBytes\(\)\)/.test(intercept[0])
);
check(
  'the refreshed total is written back onto the item',
  !!intercept && /if \(latestTotal > 0\) downloadItem\.totalBytes = latestTotal;/.test(intercept[0])
);
check(
  'the percentage is clamped to 0..100 on the live path',
  !!intercept &&
    /Math\.min\(\s*100,\s*Math\.max\(0, \(downloadItem\.downloadedBytes \/ downloadItem\.totalBytes\) \* 100\)/.test(
      intercept[0]
    )
);
check(
  'a negative computed speed can no longer be reported',
  !!intercept && /Math\.max\(0, \(downloadItem\.downloadedBytes - lastBytes\) \/ timeDiff\)/.test(intercept[0])
);
check(
  'totalBytes is seeded through the safe accessor',
  /totalBytes: safeNum\(\(\) => item\.getTotalBytes\(\)\)/.test(source)
);

// ---------------------------------------------------------------------------
// 3. Emission throttling on the Electron path
// ---------------------------------------------------------------------------
console.log('\n# the will-download tick flood is throttled');

check(
  'the will-download handler throttles emissions to 250ms',
  /nowTick - lastEmitTick >= 250 \|\| !emittedOnce/.test(electronHandler)
);
check(
  'the throttle timestamp is initialised',
  /let lastEmitTick = 0;/.test(source)
);

// ---------------------------------------------------------------------------
// 4. Regression guards: the monotonic-progress machinery must survive
// ---------------------------------------------------------------------------
console.log('\n# existing monotonic-progress behaviour is preserved');

check(
  '_emitProgress still clamps progress into 0..100',
  /progress: typeof d\.progress === 'number' \? Math\.min\(100, Math\.max\(0, d\.progress\)\) : 0/.test(source)
);
check(
  'partial progress is still persisted for resume',
  /updateDownloadHistory\(item\.id, \{\s*\n\s*status: 'downloading'/.test(source)
);

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailed assertions:');
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
process.exit(0);
