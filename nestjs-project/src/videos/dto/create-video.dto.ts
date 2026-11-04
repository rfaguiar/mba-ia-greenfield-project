import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsString, Length, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { VIDEO_CONTENT_TYPES } from '../../storage/storage-keys';

const videoContentTypes = Object.keys(VIDEO_CONTENT_TYPES);

function trimString(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export class CreateVideoDto {
  @ApiProperty({ minLength: 1, maxLength: 100 })
  @Transform(({ value }) => trimString(value))
  @IsString()
  @Length(1, 100)
  title: string;

  @ApiProperty({ minLength: 1, maxLength: 255 })
  @IsString()
  @Length(1, 255)
  original_filename: string;

  @ApiProperty({ enum: videoContentTypes })
  @IsString()
  @IsIn(videoContentTypes)
  content_type: string;

  @ApiProperty({ minimum: 1, type: Number })
  @IsInt()
  @Min(1)
  size_bytes: number;
}

export class PresignedPartDto {
  @ApiProperty()
  part_number: number;

  @ApiProperty()
  url: string;
}

export class UploadSessionDto {
  @ApiProperty()
  upload_id: string;

  @ApiProperty()
  part_size_bytes: number;

  @ApiProperty()
  part_count: number;

  @ApiProperty({ format: 'date-time' })
  expires_at: Date;

  @ApiProperty({ type: [PresignedPartDto] })
  parts: PresignedPartDto[];
}

export class CreatedVideoDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ enum: ['draft'] })
  status: 'draft';

  @ApiProperty({ format: 'date-time' })
  created_at: Date;

  @ApiProperty({ type: UploadSessionDto })
  upload: UploadSessionDto;
}

export class UploadedPartDto {
  @ApiProperty()
  part_number: number;

  @ApiProperty()
  size: number;
}

export class UploadPartsDto extends UploadSessionDto {
  @ApiProperty({ type: [UploadedPartDto] })
  uploaded_parts: UploadedPartDto[];
}

export class CompleteUploadDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: ['processing'] })
  status: 'processing';
}
