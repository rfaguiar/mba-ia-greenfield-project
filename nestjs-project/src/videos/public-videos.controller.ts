import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import {
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { Public } from '../auth/decorators/public.decorator';
import { PublicVideoDto, PresignedUrlDto } from './dto/public-video.dto';
import { PublicVideosService } from './public-videos.service';

@ApiTags('videos')
@Controller('videos')
@Throttle({ default: { limit: 120, ttl: 60000 } })
export class PublicVideosController {
  constructor(private readonly videos: PublicVideosService) {}

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Get public metadata for a ready video' })
  @ApiResponse({ status: 200, type: PublicVideoDto })
  @ApiResponse({
    status: 400,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 429,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  metadata(@Param('id', ParseUUIDPipe) id: string): Promise<PublicVideoDto> {
    return this.videos.metadata(id);
  }

  @Public()
  @Get(':id/stream')
  @ApiOperation({ summary: 'Get a short-lived streaming URL' })
  @ApiResponse({ status: 200, type: PresignedUrlDto })
  @ApiResponse({
    status: 400,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 429,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  stream(@Param('id', ParseUUIDPipe) id: string): Promise<PresignedUrlDto> {
    return this.videos.stream(id);
  }

  @Public()
  @Get(':id/download')
  @ApiOperation({ summary: 'Get a short-lived download URL' })
  @ApiResponse({ status: 200, type: PresignedUrlDto })
  @ApiResponse({
    status: 400,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 429,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  download(@Param('id', ParseUUIDPipe) id: string): Promise<PresignedUrlDto> {
    return this.videos.download(id);
  }

  @Public()
  @Get(':id/thumbnail')
  @ApiOperation({ summary: 'Get a short-lived thumbnail URL' })
  @ApiResponse({ status: 200, type: PresignedUrlDto })
  @ApiResponse({
    status: 400,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 429,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  thumbnail(@Param('id', ParseUUIDPipe) id: string): Promise<PresignedUrlDto> {
    return this.videos.thumbnail(id);
  }
}
