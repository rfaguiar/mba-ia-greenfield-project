import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';
import type { VideoMetadata } from '../entities/video.entity';

export class OwnerVideoDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  channel_id: string;

  @ApiProperty()
  title: string;

  @ApiProperty()
  original_filename: string;

  @ApiProperty()
  content_type: string;

  @ApiProperty()
  size_bytes: number;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty({ nullable: true })
  duration_seconds: number | null;

  @ApiProperty({ nullable: true, type: 'object', additionalProperties: true })
  metadata: VideoMetadata | null;

  @ApiProperty({ nullable: true })
  error_code: string | null;

  @ApiProperty({ nullable: true })
  error_message: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at: Date;

  @ApiProperty({ format: 'date-time' })
  updated_at: Date;

  @ApiProperty({ format: 'date-time', nullable: true })
  processed_at: Date | null;
}
