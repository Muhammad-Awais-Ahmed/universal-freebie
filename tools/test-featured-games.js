const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  getFeaturedGamesMeta,
  sanitizeSteamHtml,
  normalizeTokens,
  jaccard,
  pickBestCandidate,
  truncateAtSentence,
} = require('../src/backend/featuredGames');
const catalog = require('../src/data/featuredGames.json');

async function run() {
  // Catalog integrity
  assert.ok(Array.isArray(catalog.games), 'catalog.games must be an array');
  assert.ok(catalog.games.length >= 40, `expected >=40 games, got ${catalog.games.length}`);
  const ids = new Set();
  for (const game of catalog.games) {
    assert.ok(game && typeof game.id === 'string' && game.id.trim(), 'game.id required');
    assert.ok(!ids.has(game.id), `duplicate id: ${game.id}`);
    ids.add(game.id);
    assert.ok(typeof game.title === 'string' && game.title.trim(), `title required for ${game.id}`);
    assert.ok(typeof game.description === 'string' && game.description.trim(), `description required for ${game.id}`);
    if (game.steamQuery != null) {
      assert.ok(typeof game.steamQuery === 'string' && game.steamQuery.trim(), `steamQuery must be string if present for ${game.id}`);
    }
    if (game.steamYear != null) {
      assert.ok(typeof game.steamYear === 'number' && Number.isFinite(game.steamYear), `steamYear must be number if present for ${game.id}`);
    }
  }

  // Ensure key franchises from user list are present
  const required = [
    'gta-vice-city',
    'gta-liberty-city',
    'nfs-most-wanted-2005',
    'nfs-most-wanted-2012',
    'max-payne-1',
    'max-payne-2',
    'igi-1',
    'igi-2',
    'fifa-08',
    'fifa-10',
    'aoe-1',
    'aoe-2',
    'aoe-3',
    'cod-2003',
    'cod-modern-warfare-4',
    'cod-modern-warfare-2',
    'cod-black-ops',
    'hitman-codename-47',
    'hitman-silent-assassin',
    'hitman-contracts',
    'hitman-blood-money',
    'hitman-absolution',
    'hitman-2016',
    'assassins-creed-1',
    'assassins-creed-2',
    'assassins-creed-3',
    'far-cry-1',
    'far-cry-2',
    'far-cry-3',
    'total-overdose',
    'freedom-fighters',
    'tomb-raider-2013',
    'postal-2',
    'dead-space-1',
    'dead-space-2',
    'dead-space-3',
    'return-to-castle-wolfenstein',
    'wolfenstein-2009',
    'splinter-cell-1',
    'splinter-cell-chaos-theory',
    'splinter-cell-blacklist',
  ];
  for (const id of required) {
    assert.ok(ids.has(id), `missing required catalog entry: ${id}`);
  }

  // sanitizeSteamHtml
  assert.strictEqual(sanitizeSteamHtml('<p>Hello<br/>World</p>'), 'Hello\nWorld');
  assert.strictEqual(sanitizeSteamHtml('<li>Item</li><li>Two</li>'), '• Item\n• Two');
  assert.strictEqual(sanitizeSteamHtml('&amp;&lt;&gt;&quot;&#39;'), '&<>"\'');
  assert.strictEqual(sanitizeSteamHtml('&#x41;&#65;'), 'AA');

  // normalizeTokens
  assert.deepStrictEqual(normalizeTokens("Assassin's Creed II"), ['assassins', 'creed', '2']);
  assert.deepStrictEqual(normalizeTokens('Wolfenstein'), ['wolfenstein']);
  assert.deepStrictEqual(normalizeTokens('Need for Speed'), ['need', 'for', 'speed']);

  // jaccard
  assert.ok(jaccard(['wolfenstein'], ['wolfenstein', 'the', 'new', 'order']) < 0.55);
  assert.ok(jaccard(['wolfenstein'], ['wolfenstein', '2']) < 0.55);
  assert.ok(jaccard(['wolfenstein'], ['wolfenstein']) >= 0.55);

  // pickBestCandidate
  const candidates = pickBestCandidate(
    [
      { id: 1, name: 'Wolfenstein: The New Order', type: 'game' },
      { id: 2, name: 'Wolfenstein', type: 'game' },
    ],
    'Wolfenstein',
    2009,
  );
  assert.ok(Array.isArray(candidates) && candidates.length > 0, 'should return candidates');
  assert.strictEqual(candidates[0].item.id, 2, 'should prefer exact Wolfenstein over New Order');

  // truncateAtSentence
  const long = 'First sentence. Second sentence that is much longer and goes on. Third.';
  const truncated = truncateAtSentence(long, 40);
  assert.ok(truncated.endsWith('…') || truncated.length <= 40);

  // getFeaturedGamesMeta with injected fetcher
  const tempCache = path.join(os.tmpdir(), `uf-featured-${Date.now()}-${Math.random()}.json`);
  let fetchCount = 0;
  const fakeFetcher = async (url, params) => {
    fetchCount += 1;
    if (url.includes('storesearch')) {
      return {
        data: [
          { id: 620, name: 'Portal 2', type: 'game' },
          { id: 400, name: 'Portal', type: 'game' },
        ],
      };
    }
    if (url.includes('appdetails')) {
      return {
        data: {
          620: {
            success: true,
            data: {
              name: 'Portal 2',
              short_description: 'Test chambers.',
              detailed_description: '<p>Portal 2 is a first-person puzzle game.</p>',
              header_image: 'https://example.com/header.jpg',
              release_date: { date: 'Apr 19, 2011' },
            },
          },
        },
      };
    }
    return { data: {} };
  };
  const meta = await getFeaturedGamesMeta(
    [{ id: 'portal-2', title: 'Portal 2', steamQuery: 'Portal 2', steamYear: 2011 }],
    { cachePath: tempCache, fetcher: fakeFetcher, now: 1000 },
  );
  assert.ok(meta['portal-2'], 'should return meta for portal-2');
  assert.strictEqual(meta['portal-2'].appId, 620);
  assert.strictEqual(meta['portal-2'].shortDescription, 'Test chambers.');
  assert.strictEqual(meta['portal-2'].headerImage, 'https://example.com/header.jpg');

  // cache hit should not increase fetch count
  const meta2 = await getFeaturedGamesMeta(
    [{ id: 'portal-2', title: 'Portal 2', steamQuery: 'Portal 2', steamYear: 2011 }],
    { cachePath: tempCache, fetcher: fakeFetcher, now: 2000 },
  );
  assert.ok(meta2['portal-2']);
  assert.strictEqual(fetchCount, 2, 'fetch count should remain 2 on cache hit');

  // TTL expiry should refetch
  const meta3 = await getFeaturedGamesMeta(
    [{ id: 'portal-2', title: 'Portal 2', steamQuery: 'Portal 2', steamYear: 2011 }],
    { cachePath: tempCache, fetcher: fakeFetcher, now: 1000 + 8 * 24 * 60 * 60 * 1000 },
  );
  assert.ok(meta3['portal-2']);
  assert.strictEqual(fetchCount, 4, 'fetch count should increase on TTL expiry');

  // steamQuery null -> no entry
  const meta4 = await getFeaturedGamesMeta(
    [{ id: 'no-steam', title: 'No Steam', steamQuery: null }],
    { cachePath: tempCache, fetcher: fakeFetcher, now: 5000 },
  );
  assert.strictEqual(Object.keys(meta4).length, 0);

  // fetcher throw -> no throw, no entry
  const throwingFetcher = async () => {
    throw new Error('network down');
  };
  const meta5 = await getFeaturedGamesMeta(
    [{ id: 'bad', title: 'Bad', steamQuery: 'Bad Game', steamYear: 2020 }],
    { cachePath: tempCache, fetcher: throwingFetcher, now: 6000 },
  );
  assert.strictEqual(Object.keys(meta5).length, 0);

  try {
    fs.unlinkSync(tempCache);
  } catch (error) {
    // ignore
  }

  console.log('✓ featured games tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
