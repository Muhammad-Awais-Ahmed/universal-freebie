const axios = require('axios');
const cheerio = require('cheerio');

async function searchModDB(query) {
  try {
    const url = `https://www.moddb.com/mods?filter=t&kw=${encodeURIComponent(query)}`;
    const { data } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const $ = cheerio.load(data);
    const results = [];

    $('.row.rowcontent').each((index, element) => {
      if (index >= 10) return;
      
      const titleElement = $(element).find('h4 a');
      const title = titleElement.text().trim();
      const pageUrl = 'https://www.moddb.com' + titleElement.attr('href');
      
      if (title && pageUrl) {
        results.push({
          id: pageUrl,
          title: title,
          size: 'Varies',
          source: 'ModDB',
          url: pageUrl
        });
      }
    });

    return results;
  } catch (error) {
    console.error('ModDB search error:', error.message);
    return [];
  }
}

module.exports = { searchModDB };
