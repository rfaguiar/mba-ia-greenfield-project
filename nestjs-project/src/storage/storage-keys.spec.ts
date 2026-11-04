import { originalKey, thumbnailKey } from './storage-keys';

describe('storage keys', () => {
  it.each([
    ['video/mp4', 'mp4'],
    ['video/quicktime', 'mov'],
    ['video/webm', 'webm'],
    ['video/x-matroska', 'mkv'],
  ])('maps %s to a stable original extension', (contentType, extension) => {
    expect(originalKey('channel', 'video', contentType)).toBe(
      `channel/video/original.${extension}`,
    );
  });

  it('rejects unsupported content types', () => {
    expect(() => originalKey('channel', 'video', '../../script.exe')).toThrow(
      'Unsupported video content type',
    );
  });

  it('uses the deterministic JPEG thumbnail key', () => {
    expect(thumbnailKey('channel', 'video')).toBe(
      'channel/video/thumbnail.jpg',
    );
  });
});
