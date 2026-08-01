const axios = require('axios');
const cheerio = require('cheerio');

async function searchFileCR(query) {
  try {
    const url = `https://filecr.com/en/?q=${encodeURIComponent(query)}`;
    const { data } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const $ = cheerio.load(data);
    const results = [];

    $('a').each((index, element) => {
      if (results.length >= 10) return;
      
      const href = $(element).attr('href');
      const text = $(element).text().trim();
      
      if (href && href.startsWith('/') && text.length > 5 && text.toLowerCase().includes(query.toLowerCase().split(' ')[0])) {
        if (!results.some(r => r.url === `https://filecr.com${href}`)) {
          const fullUrl = `https://filecr.com${href}`;
          results.push({
            id: fullUrl,
            title: text.replace(/\n/g, '').trim(),
            size: 'N/A',
            source: 'FileCR',
            url: fullUrl
          });
        }
      }
    });

    return results;
  } catch (error) {
    console.error('FileCR search error:', error.message);
    return [];
  }
}

module.exports = { searchFileCR };
