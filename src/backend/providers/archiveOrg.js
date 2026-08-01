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

async function getArchiveOrgDownload(identifier) {
  try {
    const url = `https://archive.org/metadata/${identifier}`;
    const response = await axios.get(url);
    const files = response.data?.files || [];
    
    const validExtensions = ['.iso', '.zip', '.rar', '.7z', '.exe'];
    let bestFile = null;
    
    for (const file of files) {
      const name = (file.name || '').toLowerCase();
      const format = (file.format || '').toLowerCase();
      
      if (validExtensions.some(ext => name.endsWith(ext)) || format.includes('iso') || format.includes('zip') || format.includes('executable')) {
        if (format.includes('metadata') || format.includes('thumbnail') || format.includes('jpeg') || format.includes('png') || name.endsWith('.xml') || name.endsWith('.sqlite')) {
          continue;
        }
        
        if (!bestFile || parseInt(file.size || 0) > parseInt(bestFile.size || 0)) {
          bestFile = file;
        }
      }
    }
    
    if (bestFile) {
      return {
        url: `https://archive.org/download/${identifier}/${bestFile.name}`,
        filename: bestFile.name,
        size: bestFile.size,
        format: bestFile.format
      };
    }
    
    return null;
  } catch (error) {
    console.error('Archive.org metadata error:', error);
    return null;
  }
}

module.exports = {
  searchArchiveOrg,
  getArchiveOrgDownload
};
