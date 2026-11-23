const assert = require('assert');
const { expandSearchTerms, normalize } = require('../src/backend/searchAliases');

function includesTerm(terms, expected) {
  return terms.some((term) => normalize(term) === normalize(expected));
}

assert.ok(includesTerm(expandSearchTerms('gta vc'), 'Grand Theft Auto Vice City'));
assert.ok(includesTerm(expandSearchTerms('GTA VC'), 'gta vice city'));
assert.ok(includesTerm(expandSearchTerms('NFS MW'), 'Need For Speed Most Wanted'));
assert.ok(includesTerm(expandSearchTerms('IGI 1'), 'Project IGI 1'));
assert.ok(includesTerm(expandSearchTerms('IGI CS'), 'IGI 2 Covert Strike'));
assert.ok(includesTerm(expandSearchTerms('AC 2'), "Assassin's Creed 2"));
assert.ok(includesTerm(expandSearchTerms('FC3'), 'Far Cry 3'));
assert.ok(includesTerm(expandSearchTerms('RTCW'), 'Return to Castle Wolfenstein'));
assert.ok(includesTerm(expandSearchTerms('Wolf 2009'), 'Wolfenstein 2009'));
assert.ok(expandSearchTerms('unknown indie title').length >= 1);

console.log('✓ search alias tests passed');
