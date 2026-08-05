// Verify the ApunKaGames recorder/replayer additions parse correctly.
const fs = require('fs');
const src = fs.readFileSync('c:/Users/talha/universal-freebie/production/electron/main.js', 'utf8');

function extractConst(name) {
  const m = src.match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`;'));
  if (!m) { console.log('FAIL: const ' + name + ' not found'); process.exit(1); }
  return m[1];
}

let ok = true;
const mark = (name, pass) => { console.log((pass ? 'PASS' : 'FAIL') + ': ' + name); if (!pass) ok = false; };

// 1. Main.js parses (node -c done separately); check key functions exist
for (const fn of ['apunkaFlowPath', 'loadRecordedFlow', 'saveRecordedFlow', 'recordApunKaGamesFlow', 'waitForSelector', 'clickFound', 'replayChain', 'replayApunKaGamesPart', 'replayApunKaGamesFlow']) {
  mark('function ' + fn, src.includes('function ' + fn));
}
mark("IPC reset-apunkagames-flow", src.includes("ipcMain.handle('reset-apunkagames-flow'"));
mark('handler uses record first', src.includes('recordApunKaGamesFlow(gameUrl, gameData)'));
mark('provider fallback kept', src.includes('getApunKaGamesDownload(gameUrl)'));

// 2. Constants parse as standalone JS
const helpers = extractConst('ugcReplayHelpers');
try { new Function(helpers); mark('ugcReplayHelpers parses (' + helpers.length + ' chars)', true); }
catch (e) { mark('ugcReplayHelpers parses: ' + e.message, false); }

const recorder = extractConst('ugcRecorderScript');
try { new Function(recorder); mark('ugcRecorderScript parses (' + recorder.length + ' chars)', true); }
catch (e) { mark('ugcRecorderScript parses: ' + e.message, false); }

const tfl = extractConst('tflAutoClickScript');
try { new Function(tfl); mark('tflAutoClickScript parses', true); }
catch (e) { mark('tflAutoClickScript parses: ' + e.message, false); }

// 3. No leftover template interpolations in the constants (must not contain ${)
for (const [nm, s] of [['ugcReplayHelpers', helpers], ['ugcRecorderScript', recorder]]) {
  const bad = s.match(/\$\{[^}]+\}/g) || [];
  mark(nm + ' has no unresolved interpolations', bad.length === 0);
}

// 4. Replay overlay dom-ready template (inside replayApunKaGamesPart) parses after interpolation
const repIdx = src.indexOf('ugc-replay-overlay');
if (repIdx > 0) {
  const before = src.slice(0, repIdx);
  const bt = before.lastIndexOf('`');
  const closeIdx = src.indexOf('`).catch', repIdx);
  let overlay = src.slice(bt + 1, closeIdx);
  overlay = overlay
    .replace('${partIndex}', '1')
    .replace('${totalParts}', '3')
    .replace('${tflAutoClickScript}', tfl);
  const leftover = overlay.match(/\$\{[^}]+\}/g) || [];
  mark('replay overlay has no unresolved interpolations', leftover.length === 0);
  try { new Function(overlay); mark('replay overlay parses (' + overlay.length + ' chars)', true); }
  catch (e) { mark('replay overlay parses: ' + e.message, false); }
} else {
  mark('replay overlay found', false);
}

// 5. Recorder marker strings
mark('REC panel id', recorder.includes("'ugc-rec-panel'"));
mark('Stop & Save button', recorder.includes('ugc-rec-stop-btn'));
mark('gip_form target=_blank intercept', recorder.includes("form.target === '_blank'"));
mark('buildRec used in catcher', recorder.includes('buildRec(el)'));
mark('findEls text matching', helpers.includes("sel.indexOf('text:') === 0"));
mark('waitForSelector JSON selectors', src.includes('const sels = ${JSON.stringify(selectors)};'));
mark('clickFound navigates links in-window', src.includes('window.location.href = el.href'));

process.exit(ok ? 0 : 1);
