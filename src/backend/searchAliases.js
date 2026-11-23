// Local smart-search aliases. No external AI/API is required.
// These expansions help short names match full provider titles and vice versa.

const ALIAS_GROUPS = [
  { terms: ['gta vice city', 'grand theft auto vice city', 'gta vc', 'gtavc'], canonical: 'Grand Theft Auto Vice City' },
  { terms: ['gta liberty city', 'grand theft auto liberty city stories', 'gta lcs', 'gtalc'], canonical: 'Grand Theft Auto Liberty City Stories' },
  { terms: ['nfs most wanted', 'need for speed most wanted', 'nfs mw'], canonical: 'Need For Speed Most Wanted' },
  { terms: ['nfs most wanted 2005', 'need for speed most wanted 2005', 'mw 2005'], canonical: 'Need For Speed Most Wanted 2005' },
  { terms: ['nfs most wanted 2012', 'need for speed most wanted 2012', 'mw 2012'], canonical: 'Need For Speed Most Wanted 2012' },
  { terms: ['max payne 1', 'max payne', 'mp1'], canonical: 'Max Payne' },
  { terms: ['max payne 2', 'max payne the fall of max payne', 'mp2'], canonical: 'Max Payne 2 The Fall of Max Payne' },
  { terms: ['igi 1', 'project igi', 'project igi im going in', 'igi'], canonical: 'Project IGI 1' },
  { terms: ['igi 2', 'igi covert strike', 'project igi 2', 'igi cs'], canonical: 'IGI 2 Covert Strike' },
  { terms: ['fifa 08', 'fifa 2008', 'fifa 08 2007'], canonical: 'FIFA 08' },
  { terms: ['fifa 10', 'fifa 2010', 'fifa 10 2009'], canonical: 'FIFA 10' },
  { terms: ['age of empires 1', 'age of empires', 'aoe 1', 'aoe1'], canonical: 'Age of Empires' },
  { terms: ['age of empires 2', 'aoe 2', 'aoe2', 'age of empires ii'], canonical: 'Age Of Empires 2' },
  { terms: ['age of empires 3', 'aoe 3', 'aoe3', 'age of empires iii'], canonical: 'Age Of Empires 3' },
  { terms: ['call of duty', 'cod', 'call of duty series'], canonical: 'Call Of Duty' },
  { terms: ['hitman 1', 'hitman codename 47', 'h1'], canonical: 'Hitman Codename 47' },
  { terms: ['hitman 2', 'hitman 2 silent assassin', 'h2'], canonical: 'Hitman 2 Silent Assassin' },
  { terms: ['hitman 3', 'hitman contracts', 'h3'], canonical: 'Hitman Contracts' },
  { terms: ['hitman 4', 'hitman blood money', 'h4'], canonical: 'Hitman Blood Money' },
  { terms: ['hitman 5', 'hitman absolution', 'h5'], canonical: 'Hitman Absolution' },
  { terms: ['assassins creed 1', "assassin's creed", 'ac 1', 'ac1'], canonical: "Assassin's Creed" },
  { terms: ['assassins creed 2', 'assassins creed ii', 'ac 2', 'ac2'], canonical: "Assassin's Creed 2" },
  { terms: ['assassins creed 3', 'assassins creed iii', 'ac 3', 'ac3'], canonical: "Assassin's Creed 3" },
  { terms: ['far cry 1', 'far cry', 'fc1'], canonical: 'Far Cry' },
  { terms: ['far cry 2', 'fc2'], canonical: 'Far Cry 2' },
  { terms: ['far cry 3', 'fc3'], canonical: 'Far Cry 3' },
  { terms: ['tomb raider 2013', 'tomb raider reboot', 'tr2013'], canonical: 'Tomb Raider 2013' },
  { terms: ['return to castle wolfenstein', 'rtcw', 'wolfenstein 2001'], canonical: 'Return to Castle Wolfenstein' },
  { terms: ['wolfenstein 2009', 'wolfenstein', 'wolf 2009'], canonical: 'Wolfenstein 2009' },
  { terms: ['splinter cell', 'sc', 'splintercell'], canonical: 'Splinter Cell' },
  { terms: ['splinter cell chaos theory', 'scct', 'chaos theory'], canonical: 'Splinter Cell Chaos Theory' },
  { terms: ['splinter cell blacklist', 'scb'], canonical: 'Splinter Cell Blacklist' },
];

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function expandSearchTerms(query) {
  const raw = String(query || '').trim();
  const normalized = normalize(raw);
  if (!normalized) return [];

  const terms = [raw];
  for (const group of ALIAS_GROUPS) {
    const compactTerms = group.terms.map(normalize);
    const matches = compactTerms.some((term) => {
      if (normalized === term) return true;
      if (term.length < 8) return false;
      return normalized.includes(term) || term.includes(normalized);
    });
    if (matches) {
      terms.push(group.canonical);
      for (const term of group.terms) terms.push(term);
    }
  }

  const seen = new Set();
  return terms
    .map((term) => term.trim())
    .filter((term) => term && !seen.has(normalize(term)) && seen.add(normalize(term)))
    .slice(0, 6);
}

module.exports = { expandSearchTerms, normalize };