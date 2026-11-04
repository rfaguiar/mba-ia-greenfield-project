import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  ERROR = 'error',
}

export const VIDEO_ERROR_MESSAGES = {
  INVALID_MEDIA: 'The file is not a valid video',
  UNSUPPORTED_CODEC: 'The video format or codec is not supported',
  PROCESSING_FAILED: 'Video processing failed, please upload again',
  PROCESSING_TIMEOUT: 'Video processing took too long and was stopped',
  UPLOAD_EXPIRED: 'The upload was not completed in time',
  UPLOAD_ABORTED: 'The upload was cancelled',
  UPLOAD_SIZE_MISMATCH:
    'The uploaded file size does not match the declared size',
  STORAGE_UNAVAILABLE: 'The upload could not be started',
} as const;

export type VideoErrorCode = keyof typeof VIDEO_ERROR_MESSAGES;

export interface VideoMetadata {
  container: string;
  codec: string;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
}

const bigintNumberTransformer = {
  to: (value: number): string => String(value),
  from: (value: string | number): number => Number(value),
};

const numericNumberTransformer = {
  to: (value: number | null): number | null => value,
  from: (value: string | number | null): number | null =>
    value === null ? null : Number(value),
};

@Entity('videos')
@Index('IDX_videos_channel_id', ['channel_id'])
@Index('IDX_videos_status_created_at', ['status', 'created_at'])
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 100 })
  title: string;

  @Column({ type: 'varchar', length: 255 })
  original_filename: string;

  @Column({ type: 'varchar', length: 100 })
  content_type: string;

  @Column({ type: 'bigint', transformer: bigintNumberTransformer })
  size_bytes: number;

  @Column({
    type: 'enum',
    enum: VideoStatus,
    enumName: 'videos_status_enum',
    default: VideoStatus.DRAFT,
  })
  status: VideoStatus;

  @Column({ type: 'varchar', nullable: true })
  upload_id: string | null;

  @Column({
    type: 'numeric',
    precision: 10,
    scale: 3,
    nullable: true,
    transformer: numericNumberTransformer,
  })
  duration_seconds: number | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: VideoMetadata | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  error_code: VideoErrorCode | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  error_message: string | null;

  @Column({ type: 'timestamp', nullable: true })
  processing_started_at: Date | null;

  @Column({ type: 'int', default: 0 })
  processing_attempts: number;

  @Column({ type: 'timestamp', nullable: true })
  processed_at: Date | null;

  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos, {
    nullable: false,
    onDelete: 'NO ACTION',
  })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
