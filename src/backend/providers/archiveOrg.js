const axios = require('axios');

async function searchArchiveOrg(query) {
  try {
    const encodedQuery = encodeURIComponent(`title:("${query}") AND mediatype:(software)`);
    const url = `https://archive.org/advancedsearch.php?q=${encodedQuery}&fl[]=identifier,title,description,downloads,item_size,year&rows=20&output=json`;
    
    const response = await axios.get(url);
    const docs = response.data?.response?.docs || [];
    
    return docs.map(doc => ({
      id: doc.identifier,
      title: doc.title || 'Unknown Title',
      source: 'Archive.org',
      description: doc.description || '',
      downloads: doc.downloads || 0,
      size: doc.item_size || 'Unknown Size',
      year: doc.year || 'Unknown Year',
      thumbnail: `https://archive.org/services/img/${doc.identifier}`
    }));
  } catch (error) {
    console.error('Archive.org search error:', error);
    return [];
  }
}

async function getArchiveOrgFiles(identifier) {
  try {
    const url = `https://archive.org/metadata/${encodeURIComponent(identifier)}`;
    const response = await axios.get(url, { timeout: 30000 });
    const files = response.data?.files || [];

    const payloads = files
      .filter(isGamePayload)
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true }))
      .map(file => ({
        url: buildDownloadUrl(identifier, file.name),
        filename: file.name,
        size: file.size || 0,
        format: file.format || ''
      }));

    if (!payloads.length) {
      return { error: 'No downloadable game files (ISO/ZIP/RAR/7Z/EXE/IMG/BIN...) found on this Archive.org item.' };
    }

    const totalSize = payloads.reduce((sum, f) => sum + (parseInt(f.size, 10) || 0), 0);

    return { files: payloads, totalSize };
  } catch (error) {
    console.error('Archive.org metadata error:', error);
    return { error: `Archive.org metadata request failed: ${error.message}` };
  }
}

// Real game payload: disc images, archives and installers. Split archives like
// .7z.001 / .zip.01 and partN.rar are matched by the optional (.\d+)? suffix.
const PAYLOAD_RE = /\.(iso|zip|rar|7z|exe|bin|cue|img|mdf|nrg|ccd|mds|sub|dmg)(\.\d+)?$/i;

// Noise files that ship inside items but are NOT part of the game itself:
// metadata, thumbnails, torrents, text instructions, checksums, etc.
const NOISE_RE = /\.(txt|xml|sqlite|json|csv|log|m3u|nfo|html?|gif|jpe?g|png|webp|bmp|torrent|url|sfv|md5|sha1?|sig|asc|css|js|db|ini|cfg|conf|htm)$/i;

function isGamePayload(file) {
  const name = (file.name || '').toLowerCase();
  if (!PAYLOAD_RE.test(name)) return false;
  if (NOISE_RE.test(name)) return false;
  // Metadata-only entries from the files list (e.g. _meta.xml, __ia_thumb.jpg).
  const format = (file.format || '').toLowerCase();
  if (format.includes('metadata') || format.includes('thumbnail') || format.includes('jpeg') || format.includes('png')) return false;
  return true;
}

function buildDownloadUrl(identifier, name) {
  const encoded = name.split('/').map(encodeURIComponent).join('/');
  return `https://archive.org/download/${encodeURIComponent(identifier)}/${encoded}`;
}

module.exports = {
  searchArchiveOrg,
  getArchiveOrgFiles
};
