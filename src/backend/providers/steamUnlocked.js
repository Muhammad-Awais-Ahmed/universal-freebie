const axios = require('axios');
const cheerio = require('cheerio');

// Search pagination: scroll through every result page (up to SEARCH_MAX_PAGES)
// so ALL matches load; the main process then ranks them by relevance.
const SEARCH_MAX_PAGES = 4;

async function searchSteamUnlocked(query) {
  const results = [];
  const seen = new Set();
  try {
    for (let page = 1; page <= SEARCH_MAX_PAGES; page++) {
      const url = page === 1
        ? `https://steamunlocked.org/?s=${encodeURIComponent(query)}`
        : `https://steamunlocked.org/page/${page}/?s=${encodeURIComponent(query)}`;

      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        timeout: 20000
      });

      const $ = cheerio.load(response.data);
      let pageCount = 0;

      $('.cover-item.category').each((i, element) => {
        const titleElem = $(element).find('.cover-item-title a h2');
        const title = titleElem.text().trim();
        const link = $(element).find('.cover-item-title a').attr('href');
        if (!title || !link || seen.has(link)) return;

        const imgElem = $(element).find('.cover-item-image img');
        const thumbnail = imgElem.attr('src') || imgElem.attr('data-src');

        let year = 'Unknown Year';
        const yearMatch = title.match(/\b(19\d\d|20\d\d)\b/);
        if (yearMatch) {
          year = yearMatch[1];
        }

        seen.add(link);
        pageCount++;
        results.push({
          id: link,
          title: title,
          source: 'SteamUnlocked',
          description: 'Pre-installed PC Game',
          year: year,
          thumbnail: thumbnail || 'https://steamunlocked.org/wp-content/uploads/2025/10/SteamUnlocked.png',
          url: link
        });
      });

      // Nothing new on this page -> no more pages to scroll
      if (pageCount === 0) break;
    }

    return results;
  } catch (error) {
    console.error('SteamUnlocked search error:', error);
    return results;
  }
}

async function getSteamUnlockedDownload(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    
    const $ = cheerio.load(response.data);
    
    const downloadBtn = $('a.btn-download');
    const uploadHavenUrl = downloadBtn.attr('href');
    
    if (uploadHavenUrl && uploadHavenUrl.includes('uploadhaven')) {
      return {
        url: uploadHavenUrl,
        filename: 'SteamUnlocked-Game.zip',
        format: 'uploadhaven_link',
        isUploadHaven: true
      };
    }
    
    return null;
  } catch (error) {
    console.error('SteamUnlocked download extraction error:', error);
    return null;
  }
}

module.exports = {
  searchSteamUnlocked,
  getSteamUnlockedDownload
};
