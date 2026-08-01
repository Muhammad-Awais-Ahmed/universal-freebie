const axios = require('axios');
const cheerio = require('cheerio');

async function searchFitGirl(query) {
  try {
    const url = `https://fitgirl-repacks.site/?s=${encodeURIComponent(query)}`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    
    const $ = cheerio.load(response.data);
    const results = [];
    
    $('article.category-lossless-repack').each((i, element) => {
      const titleElem = $(element).find('.entry-title a');
      const title = titleElem.text().trim();
      const link = titleElem.attr('href');
      const date = $(element).find('time.entry-date').text().trim();
      const description = $(element).find('.entry-summary p').text().trim();
      
      let size = 'Unknown';
      const sizeMatch = description.match(/Repack Size:\s*(.+?)\s*\[/i) || description.match(/Repack Size:\s*(.+)/i);
      if (sizeMatch && sizeMatch[1]) {
        size = sizeMatch[1].trim();
      }
      
      if (title && link) {
        results.push({
          id: link,
          title: title,
          source: 'FitGirl',
          description: description,
          size: size,
          year: date,
          thumbnail: 'https://fitgirl-repacks.site/wp-content/uploads/2016/08/cropped-icon-192x192.jpg',
          url: link
        });
      }
    });
    
    const topResults = results.slice(0, 5);
    await Promise.all(topResults.map(async (result) => {
      try {
        const gameRes = await axios.get(result.url, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 4000
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
    return [];
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
