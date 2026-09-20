const axios = require('axios');
const cheerio = require('cheerio');

// Search pagination: scroll through every result page (up to SEARCH_MAX_PAGES)
// so ALL matches load; the main process then ranks them by relevance.
const SEARCH_MAX_PAGES = 4;

async function searchFitGirl(query) {
  const results = [];
  const seen = new Set();
  try {
    for (let page = 1; page <= SEARCH_MAX_PAGES; page++) {
      const url = page === 1
        ? `https://fitgirl-repacks.site/?s=${encodeURIComponent(query)}`
        : `https://fitgirl-repacks.site/page/${page}/?s=${encodeURIComponent(query)}`;

      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        timeout: 20000
      });

      const $ = cheerio.load(response.data);
      let pageCount = 0;

      $('article.category-lossless-repack').each((i, element) => {
        const titleElem = $(element).find('.entry-title a');
        const title = titleElem.text().trim();
        const link = titleElem.attr('href');
        if (!title || !link || seen.has(link)) return;

        const dateElem = $(element).find('time.entry-date');
        const date = dateElem.text().trim();
        const datetimeAttr = dateElem.attr('datetime') || '';
        const description = $(element).find('.entry-summary p').text().trim();

        let size = 'Unknown';
        const sizeMatch = description.match(/Repack Size:\s*(.+?)\s*\[/i) || description.match(/Repack Size:\s*(.+)/i);
        if (sizeMatch && sizeMatch[1]) {
          size = sizeMatch[1].trim();
        }

        let year = 'Unknown Year';
        const yearMatch = (datetimeAttr || date || '').match(/\b(19\d\d|20\d\d)\b/) || title.match(/\b(19\d\d|20\d\d)\b/);
        if (yearMatch) {
          year = yearMatch[1];
        } else if (date) {
          year = date;
        }

        seen.add(link);
        pageCount++;
        results.push({
          id: link,
          title: title,
          source: 'FitGirl',
          description: description,
          size: size,
          year: year,
          thumbnail: 'https://fitgirl-repacks.site/wp-content/uploads/2016/08/cropped-icon-192x192.jpg',
          url: link
        });
      });

      // Nothing new on this page -> no more pages to scroll
      if (pageCount === 0) break;
    }

    // Fetch real cover images for the top matches (parallel, best-effort)
    const topResults = results.slice(0, 8);
    await Promise.all(topResults.map(async (result) => {
      try {
        const gameRes = await axios.get(result.url, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 3000
        });
        const game$ = cheerio.load(gameRes.data);
        const img = game$('.entry-content img').first().attr('src') || game$('img').first().attr('src');
        if (img && img.startsWith('http')) {
          result.thumbnail = img;
        }
      } catch (e) {
        // Fallback to default icon
      }
    }));

    return results;
  } catch (error) {
    console.error('FitGirl search error:', error);
    return results;
  }
}

async function getFitGirlDownload(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    
    const $ = cheerio.load(response.data);
    
    let magnetLink = null;
    $('a[href^="magnet:"]').each((i, element) => {
      if (!magnetLink) {
        magnetLink = $(element).attr('href');
      }
    });
    
    if (magnetLink) {
      return {
        url: magnetLink,
        filename: magnetLink.match(/dn=([^&]+)/)?.[1] || 'FitGirl-Repack',
        format: 'magnet',
        isTorrent: true
      };
    }
    
    return null;
  } catch (error) {
    console.error('FitGirl download extraction error:', error);
    return null;
  }
}

module.exports = {
  searchFitGirl,
  getFitGirlDownload
};
