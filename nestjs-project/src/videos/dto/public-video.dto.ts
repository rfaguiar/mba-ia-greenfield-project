import { ApiProperty } from '@nestjs/swagger';
import type { VideoMetadata } from '../entities/video.entity';

export class PublicVideoDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  channel_id: string;

  @ApiProperty()
  title: string;

  @ApiProperty()
  content_type: string;

  @ApiProperty()
  size_bytes: number;

  @ApiProperty()
  duration_seconds: number;

  @ApiProperty({ type: 'object', additionalProperties: true })
  metadata: VideoMetadata;

  @ApiProperty({ format: 'date-time' })
  created_at: Date;

  @ApiProperty({ format: 'date-time' })
  processed_at: Date;
}

export class PresignedUrlDto {
  @ApiProperty({ format: 'uri' })
  url: string;

  @ApiProperty({ format: 'date-time' })
  expires_at: Date;
}
