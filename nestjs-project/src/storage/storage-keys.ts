export const VIDEO_CONTENT_TYPES = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
} as const;

export type VideoContentType = keyof typeof VIDEO_CONTENT_TYPES;

export function originalKey(
  channelId: string,
  videoId: string,
  contentType: string,
): string {
  const extension = Object.entries(VIDEO_CONTENT_TYPES).find(
    ([allowedType]) => allowedType === contentType,
  )?.[1];
  if (!extension) throw new Error('Unsupported video content type');
  return `${channelId}/${videoId}/original.${extension}`;
}

export function thumbnailKey(channelId: string, videoId: string): string {
  return `${channelId}/${videoId}/thumbnail.jpg`;
}
