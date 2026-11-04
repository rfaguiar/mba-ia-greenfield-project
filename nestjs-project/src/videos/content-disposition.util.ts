const MAX_FILENAME_LENGTH = 200;

export function attachmentDisposition(originalFilename: string): string {
  const basename = originalFilename
    .replace(/^.*[\\/]/, '')
    .replace(/"/g, '')
    .split('')
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join('')
    .trim()
    .slice(0, MAX_FILENAME_LENGTH);
  const filename = basename || fallbackFilename(originalFilename);
  const asciiFilename = filename.replace(/[^\x20-\x7e]/g, '_') || 'video.mp4';
  const encodedFilename = encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`;
}

function fallbackFilename(originalFilename: string): string {
  const extension = /\.([a-zA-Z0-9]{1,10})$/.exec(originalFilename)?.[1];
  return `video.${extension?.toLowerCase() ?? 'mp4'}`;
}
