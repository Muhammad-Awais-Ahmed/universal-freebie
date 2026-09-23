const axios = require('axios');
const cheerio = require('cheerio');

// Search pagination: scroll through every result page (up to SEARCH_MAX_PAGES)
// so ALL matches load; the main process then ranks them by relevance.
const SEARCH_MAX_PAGES = 4;
const DETAIL_FETCH_LIMIT = 5; // Only fetch detail pages for top N results to avoid rate limiting

async function searchSteamUnlocked(query) {
  const results = [];
  const seen = new Set();
  try {
    for (let page = 1; page <= SEARCH_MAX_PAGES; page++) {
      const url = page === 1
        ? `https://steamunlocked.org/?s=${encodeURIComponent(query)}`
        : `https://steamunlocked.org/?s=${encodeURIComponent(query)}&page=${page}`;

      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        timeout: 20000
      });

      const $ = cheerio.load(response.data);
      let pageCount = 0;

      $('a.su-cat__card').each((i, element) => {
        const titleElem = $(element).find('.su-cat__card-body h2');
        const title = titleElem.text().trim();
        const link = $(element).attr('href');
        if (!title || !link || seen.has(link)) return;

        const imgElem = $(element).find('.su-cat__card-img img');
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
          size: 'Unknown Size', // Will be populated from detail page for top results
          thumbnail: thumbnail || 'https://steamunlocked.org/wp-content/uploads/2025/10/SteamUnlocked.png',
          url: link
        });
      });

      // Nothing new on this page -> no more pages to scroll
      if (pageCount === 0) break;
    }

    // Fetch detail pages for top results to get size info
    const detailPromises = results.slice(0, DETAIL_FETCH_LIMIT).map(async (game) => {
      try {
        const detailResponse = await axios.get(game.url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          },
          timeout: 15000
        });
        const $detail = cheerio.load(detailResponse.data);
        
        // Extract size from .su-hchip--size
        const sizeChip = $detail('.su-hchip--size').first();
        if (sizeChip.length) {
          game.size = sizeChip.text().trim();
        }
        
        // Extract year from JSON-LD datePublished (year game was posted)
        if (game.year === 'Unknown Year') {
          const jsonLd = $detail('script[type="application/ld+json"]').first().html();
          if (jsonLd) {
            const dateMatch = jsonLd.match(/"datePublished"\s*:\s*"(\d{4})/);
            if (dateMatch) game.year = dateMatch[1];
          }
        }
      } catch (e) {
        // Silently ignore detail fetch errors
      }
    });
    
    await Promise.allSettled(detailPromises);

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
    
    // Find uploadhaven download link (new site structure)
    const uploadHavenLink = $('a[href*="uploadhaven.com/download/"]').first();
    const uploadHavenUrl = uploadHavenLink.attr('href');
    
    // Extract size from the game page
    let size = 'Unknown Size';
    const sizeChip = $('.su-hchip--size').first();
    if (sizeChip.length) {
      size = sizeChip.text().trim();
    }
    
    // Extract year: title year > JSON-LD datePublished
    let year = 'Unknown Year';
    const titleEl = $('h1.su-hero__title').first();
    if (titleEl.length) {
      const titleText = titleEl.text().trim();
      const titleYearMatch = titleText.match(/\b(19\d\d|20\d\d)\b/);
      if (titleYearMatch) year = titleYearMatch[1];
    }
    if (year === 'Unknown Year') {
      const jsonLd = $('script[type="application/ld+json"]').first().html();
      if (jsonLd) {
        const dateMatch = jsonLd.match(/"datePublished"\s*:\s*"(\d{4})/);
        if (dateMatch) year = dateMatch[1];
      }
    }
    
    if (uploadHavenUrl) {
      return {
        url: uploadHavenUrl,
        filename: 'SteamUnlocked-Game.zip',
        format: 'uploadhaven_link',
        isUploadHaven: true,
        size: size,
        year: year
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
