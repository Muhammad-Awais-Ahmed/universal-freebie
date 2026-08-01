const axios = require('axios');
const cheerio = require('cheerio');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function getPage(url) {
  const { data } = await axios.get(url, {
    headers: { 'User-Agent': UA },
    timeout: 20000
  });
  return data;
}

async function searchApunKaGames(query) {
  try {
    const url = `https://www.apunkagames.net/?s=${encodeURIComponent(query)}`;
    const { data } = await axios.get(url, {
      headers: {
        'User-Agent': UA
      }
    });

    const $ = cheerio.load(data);
    const results = [];

    $('.post').each((index, element) => {
      if (index >= 10) return;

      const titleElement = $(element).find('.entry-title a');
      const title = titleElement.text().trim();
      const pageUrl = titleElement.attr('href');

      const sizeStr = 'N/A';

      if (title && pageUrl) {
        results.push({
          id: pageUrl,
          title: title,
          size: sizeStr,
          source: 'ApunKaGames',
          url: pageUrl
        });
      }
    });

    return results;
  } catch (error) {
    console.error('ApunKaGames search error:', error.message);
    return [];
  }
}

/**
 * Resolves an ApunKaGames game page into TheFilesLocker part links.
 *
 * Flow (all server-side, no browser needed until the captcha step):
 *   game page -> "Click Here to Download" vlink -> hoster rows -> TheFilesLocker vlink
 *   -> part forms (download-process.php) -> real thefileslocker.net/<id>.html URLs
 *
 * Returns:
 *   { parts: [{ url, label, title }], hoster: string, totalSize: string|null }
 *   or { error: string }
 */
async function getApunKaGamesDownload(gameUrl) {
  try {
    const gameHtml = await getPage(gameUrl);
    const vlink = extractVlink(gameHtml);

    if (!vlink) {
      return { error: 'No download link found on the ApunKaGames page.' };
    }

    const vlinkHtml = await getPage(vlink);
    const hosters = extractHosterRows(vlinkHtml);

    let parts = [];
    let hosterName = null;

    if (hosters.length) {
      // Multi-host page: prefer TheFilesLocker (the reliable host), else first hoster.
      const sortedHosters = [...hosters].sort((a, b) => {
        const aTfl = /fileslocker/i.test(a.name) ? 0 : 1;
        const bTfl = /fileslocker/i.test(b.name) ? 0 : 1;
        return aTfl - bTfl;
      });

      for (const hoster of sortedHosters) {
        const hosterHtml = await getPage(hoster.url);
        const candidateParts = extractParts(hosterHtml);
        if (candidateParts.length) {
          parts = candidateParts;
          hosterName = hoster.name;
          break;
        }
      }
    } else {
      // Single-part page: the vlink page itself has the download-process.php form(s).
      parts = extractParts(vlinkHtml);
      hosterName = parts.length ? 'TheFilesLocker' : null;
    }

    if (!parts.length) {
      return { error: `No download parts found on ${hosterName || 'the link page'}.` };
    }

    return {
      parts,
      hoster: hosterName,
      totalSize: extractGameSize(gameHtml)
    };
  } catch (error) {
    console.error('getApunKaGamesDownload error:', error.message);
    return { error: `Failed to resolve ApunKaGames download: ${error.message}` };
  }
}

function extractVlink(gameHtml) {
  const $ = cheerio.load(gameHtml);
  let link =
    $('a')
      .filter((i, el) => {
        const text = $(el).text().trim().toLowerCase();
        return text.includes('click here to download');
      })
      .first()
      .attr('href') || null;

  if (!link) {
    link = $('a[href*="apunkasoftware.net/vlink"]').first().attr('href') || null;
  }
  if (!link) {
    link = $('a[href*="/vlink/"]').first().attr('href') || null;
  }
  return link ? link.trim() : null;
}

function extractHosterRows(vlinkHtml) {
  const $ = cheerio.load(vlinkHtml);
  const hosters = [];
  $('.download-row').each((i, row) => {
    const name = $(row).find('.host-name').text().trim();
    const href =
      $(row).find('a[href*="vlink"]').attr('href') ||
      $(row).find('a.download-btn').attr('href') ||
      $(row).find('a').attr('href');
    if (name && href) {
      hosters.push({ name, url: href.trim() });
    }
  });
  return hosters;
}

function extractParts(hosterHtml) {
  const $ = cheerio.load(hosterHtml);
  const parts = [];
  $('form[action*="download-process.php"]').each((i, form) => {
    const file = $(form).find('input[name="file"]').val();
    const title = $(form).find('input[name="title"]').val();
    const btn =
      $(form).find('input[type="submit"]').val() || `Part ${i + 1}`;
    // Only TheFilesLocker parts are reliably automatable
    if (file && /thefileslocker\.net/i.test(file)) {
      parts.push({ url: file.trim(), label: btn.trim(), title: (title || '').trim() });
    }
  });
  return parts;
}

function extractGameSize(gameHtml) {
  const $ = cheerio.load(gameHtml);
  const bodyText = $('body').text();
  const match = bodyText.match(/Game Size:\s*([\d.]+)\s*(TB|GB|MB)/i);
  return match ? `${match[1]} ${match[2]}` : null;
}

module.exports = { searchApunKaGames, getApunKaGamesDownload };
