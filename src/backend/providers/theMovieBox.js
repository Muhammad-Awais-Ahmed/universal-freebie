const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://themoviebox.xyz';

async function searchTheMovieBox(query) {
  try {
    const url = `${BASE_URL}/search?q=${encodeURIComponent(query)}`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    
    const $ = cheerio.load(response.data);
    const results = [];
    
    $('.movie-item, .series-item, .search-result-item, article').each((i, element) => {
      const titleElem = $(element).find('h3, h2, .title, .movie-title').first();
      const title = titleElem.text().trim();
      const link = $(element).find('a').first().attr('href');
      const imgElem = $(element).find('img').first();
      const thumbnail = imgElem.attr('src') || imgElem.attr('data-src');
      
      if (title && link) {
        results.push({
          id: link,
          title: title,
          source: 'TheMovieBox',
          description: 'Movie/TV Series',
          thumbnail: thumbnail || '',
          url: link.startsWith('http') ? link : `${BASE_URL}${link}`
        });
      }
    });
    
    return results;
  } catch (error) {
    console.error('TheMovieBox search error:', error);
    return [];
  }
}

async function getTheMovieBoxEpisodes(seriesUrl) {
  try {
    const response = await axios.get(seriesUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    
    const $ = cheerio.load(response.data);
    const episodes = [];
    
    $('.episode-item, .episode-link, a[href*="episode"], a[href*="ep="]').each((i, element) => {
      const link = $(element).attr('href');
      const text = $(element).text().trim();
      
      if (link && text) {
        const seMatch = text.match(/[Ss](\d+)[Ee](\d+)/) || text.match(/season\s*(\d+)\s*episode\s*(\d+)/i) || text.match(/ep\s*(\d+)/i);
        let season = 1, episode = 1;
        
        if (seMatch) {
          if (seMatch[1] && seMatch[2]) {
            season = parseInt(seMatch[1]);
            episode = parseInt(seMatch[2]);
          } else if (seMatch[1]) {
            episode = parseInt(seMatch[1]);
          }
        }
        
        episodes.push({
          season,
          episode,
          title: text,
          url: link.startsWith('http') ? link : `${BASE_URL}${link}`
        });
      }
    });
    
    episodes.sort((a, b) => {
      if (a.season !== b.season) return a.season - b.season;
      return a.episode - b.episode;
    });
    
    return episodes;
  } catch (error) {
    console.error('TheMovieBox episodes error:', error);
    return [];
  }
}

async function getTheMovieBoxVideoUrl(episodeUrl) {
  try {
    const response = await axios.get(episodeUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    
    const $ = cheerio.load(response.data);
    
    const videoSrc = $('video source').first().attr('src') || $('video').first().attr('src');
    if (videoSrc) return videoSrc;
    
    const iframeSrc = $('iframe').first().attr('src');
    if (iframeSrc) {
      return await resolveIframeVideo(iframeSrc);
    }
    
    const scripts = $('script').toArray();
    for (const script of scripts) {
      const content = $(script).html() || '';
      const m3u8Match = content.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/);
      if (m3u8Match) return m3u8Match[1];
      
      const mp4Match = content.match(/["'](https?:\/\/[^"']+\.mp4[^"']*)["']/);
      if (mp4Match) return mp4Match[1];
    }
    
    const playerData = $('.player, #player, .video-player').attr('data-src') || 
                       $('.player, #player, .video-player').attr('data-url');
    if (playerData) return playerData;
    
    return null;
  } catch (error) {
    console.error('TheMovieBox video URL error:', error);
    return null;
  }
}

async function resolveIframeVideo(iframeUrl) {
  try {
    const response = await axios.get(iframeUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': BASE_URL
      }
    });
    
    const $ = cheerio.load(response.data);
    
    const videoSrc = $('video source').first().attr('src') || $('video').first().attr('src');
    if (videoSrc) return videoSrc;
    
    const scripts = $('script').toArray();
    for (const script of scripts) {
      const content = $(script).html() || '';
      const m3u8Match = content.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/);
      if (m3u8Match) return m3u8Match[1];
      
      const mp4Match = content.match(/["'](https?:\/\/[^"']+\.mp4[^"']*)["']/);
      if (mp4Match) return mp4Match[1];
    }
    
    return null;
  } catch (error) {
    console.error('Iframe resolution error:', error);
    return null;
  }
}

async function getTheMovieBoxDownload(seriesUrl, startEpisode = 1, endEpisode = null) {
  try {
    const episodes = await getTheMovieBoxEpisodes(seriesUrl);
    
    if (episodes.length === 0) {
      return { error: 'No episodes found' };
    }
    
    let filteredEpisodes = episodes.filter(ep => ep.episode >= startEpisode);
    if (endEpisode) {
      filteredEpisodes = filteredEpisodes.filter(ep => ep.episode <= endEpisode);
    }
    
    const downloadLinks = [];
    
    for (const ep of filteredEpisodes) {
      const videoUrl = await getTheMovieBoxVideoUrl(ep.url);
      if (videoUrl) {
        downloadLinks.push({
          season: ep.season,
          episode: ep.episode,
          title: ep.title,
          url: videoUrl,
          filename: `${ep.title.replace(/[^a-zA-Z0-9]/g, '_')}.mp4`
        });
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    return {
      episodes: downloadLinks,
      totalEpisodes: episodes.length,
      downloadedEpisodes: downloadLinks.length
    };
  } catch (error) {
    console.error('TheMovieBox download error:', error);
    return { error: error.message };
  }
}

module.exports = {
  searchTheMovieBox,
  getTheMovieBoxEpisodes,
  getTheMovieBoxVideoUrl,
  getTheMovieBoxDownload
};
