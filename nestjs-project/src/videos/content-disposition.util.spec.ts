import { attachmentDisposition } from './content-disposition.util';

describe('attachmentDisposition', () => {
  it('returns an ASCII fallback and RFC 5987 encoded filename', () => {
    expect(attachmentDisposition('Férias 2024.mp4')).toBe(
      'attachment; filename="F_rias 2024.mp4"; filename*=UTF-8\'\'F%C3%A9rias%202024.mp4',
    );
  });

  it('removes path separators, quotes, and control characters', () => {
    const disposition = attachmentDisposition('..\\folder/a\"\r\nb.mp4');
    expect(disposition).toContain('filename="ab.mp4"');
    expect(disposition).toContain("filename*=UTF-8''ab.mp4");
    expect(disposition).not.toContain('\\');
    expect(disposition).not.toContain('\r');
    expect(disposition).not.toContain('\n');
  });

  it('falls back to a safe video filename when no basename remains', () => {
    expect(attachmentDisposition('../')).toBe(
      'attachment; filename="video.mp4"; filename*=UTF-8\'\'video.mp4',
    );
  });
});
