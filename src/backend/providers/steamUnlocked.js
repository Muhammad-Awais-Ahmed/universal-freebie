const axios = require('axios');
const cheerio = require('cheerio');

async function searchSteamUnlocked(query) {
  try {
    const url = `https://steamunlocked.org/?s=${encodeURIComponent(query)}`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    
    const $ = cheerio.load(response.data);
    const results = [];
    
    $('.cover-item.category').each((i, element) => {
      const titleElem = $(element).find('.cover-item-title a h2');
      const title = titleElem.text().trim();
      const link = $(element).find('.cover-item-title a').attr('href');
      const imgElem = $(element).find('.cover-item-image img');
      const thumbnail = imgElem.attr('src') || imgElem.attr('data-src');
      
      if (title && link) {
        results.push({
          id: link,
          title: title,
          source: 'SteamUnlocked',
          description: 'Pre-installed PC Game',
          thumbnail: thumbnail || 'https://steamunlocked.org/wp-content/uploads/2025/10/SteamUnlocked.png',
          url: link
        });
      }
    });
    
    return results;
  } catch (error) {
    console.error('SteamUnlocked search error:', error);
    return [];
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
