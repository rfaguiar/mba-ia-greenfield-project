import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { ChannelOwnerGuard } from '../channels/guards/channel-owner.guard';
import {
  CompleteUploadDto,
  CreateVideoDto,
  CreatedVideoDto,
  UploadPartsDto,
} from './dto/create-video.dto';
import { OwnerVideoDto } from './dto/owner-video.dto';
import { VideoUploadsService } from './video-uploads.service';
import { VideoLifecycleService } from './video-lifecycle.service';
import { VideoNotFoundException } from '../common/exceptions/domain.exception';
import type { Response } from 'express';

@ApiTags('videos')
@ApiBearerAuth('access-token')
@UseGuards(ChannelOwnerGuard)
@Controller('channels/:channelId/videos')
export class VideosController {
  constructor(
    private readonly uploads: VideoUploadsService,
    private readonly lifecycle: VideoLifecycleService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Start a resumable video upload' })
  @ApiResponse({
    status: 201,
    type: CreatedVideoDto,
    headers: {
      Location: {
        description: 'Owner video detail URL',
        schema: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 503,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async start(
    @Param('channelId') channelId: string,
    @Body() dto: CreateVideoDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CreatedVideoDto> {
    const result = await this.uploads.start(channelId, dto);
    response.setHeader(
      'Location',
      `/channels/${channelId}/videos/${result.id}`,
    );
    return result;
  }

  @Get(':videoId/uploads/parts')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiOperation({ summary: 'Resume a video upload' })
  @ApiResponse({ status: 200, type: UploadPartsDto })
  @ApiResponse({
    status: 400,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async resume(
    @Param('channelId') channelId: string,
    @Param('videoId', ParseUUIDPipe) videoId: string,
  ): Promise<UploadPartsDto> {
    return this.uploads.resume(channelId, videoId);
  }

  @Post(':videoId/uploads/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Complete a video upload and enqueue processing' })
  @ApiResponse({ status: 202, type: CompleteUploadDto })
  @ApiResponse({
    status: 400,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 503,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async complete(
    @Param('channelId') channelId: string,
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CompleteUploadDto> {
    const result = await this.uploads.complete(channelId, videoId);
    response.setHeader('Location', `/channels/${channelId}/videos/${videoId}`);
    return result;
  }

  @Post(':videoId/uploads/abort')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Abort a video upload' })
  @ApiResponse({ status: 204, description: 'Upload aborted' })
  @ApiResponse({
    status: 400,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async abort(
    @Param('channelId') channelId: string,
    @Param('videoId', ParseUUIDPipe) videoId: string,
  ): Promise<void> {
    return this.uploads.abort(channelId, videoId);
  }

  @Get(':videoId')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @ApiOperation({ summary: 'Get an owner video status' })
  @ApiResponse({ status: 200, type: OwnerVideoDto })
  @ApiResponse({
    status: 400,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async detail(
    @Param('channelId') channelId: string,
    @Param('videoId', ParseUUIDPipe) videoId: string,
  ): Promise<OwnerVideoDto> {
    const video = await this.lifecycle.findOwned(channelId, videoId);
    if (!video) throw new VideoNotFoundException();
    const {
      id,
      channel_id,
      title,
      original_filename,
      content_type,
      size_bytes,
      status,
      duration_seconds,
      metadata,
      error_code,
      error_message,
      created_at,
      updated_at,
      processed_at,
    } = video;
    return {
      id,
      channel_id,
      title,
      original_filename,
      content_type,
      size_bytes,
      status,
      duration_seconds,
      metadata,
      error_code,
      error_message,
      created_at,
      updated_at,
      processed_at,
    };
  }
}
