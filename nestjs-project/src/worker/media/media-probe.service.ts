import { Injectable } from '@nestjs/common';
import {
  PermanentProcessingError,
  TransientProcessingError,
} from '../processing.errors';
import {
  ProcessExitError,
  ProcessTimeoutError,
  runProcess,
} from './run-process';
import { VideoMetadata } from '../../videos/entities/video.entity';

const PROBE_TIMEOUT_MS = 60000;
const ALLOWED_FORMATS = [
  'mov',
  'mp4',
  'm4a',
  '3gp',
  '3g2',
  'mj2',
  'matroska',
  'webm',
];

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  bit_rate?: string;
  duration?: string;
}

interface ProbeOutput {
  format?: {
    format_name?: string;
    duration?: string;
    bit_rate?: string;
  };
  streams?: ProbeStream[];
}

export interface ProbeResult {
  durationSeconds: number;
  metadata: VideoMetadata;
}

@Injectable()
export class MediaProbeService {
  async probe(filePath: string, signal?: AbortSignal): Promise<ProbeResult> {
    let output: string;
    try {
      output = await runProcess(
        'ffprobe',
        [
          '-v',
          'error',
          '-protocol_whitelist',
          'file',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          '--',
          filePath,
        ],
        { timeoutMs: PROBE_TIMEOUT_MS, signal },
      );
    } catch (error) {
      if (error instanceof ProcessTimeoutError) {
        throw new TransientProcessingError('ffprobe timed out');
      }
      if (error instanceof ProcessExitError) {
        if (error.exitCode === null) {
          throw new TransientProcessingError('ffprobe could not start');
        }
        throw new PermanentProcessingError('INVALID_MEDIA');
      }
      throw new TransientProcessingError('ffprobe could not run');
    }

    let probe: ProbeOutput;
    try {
      probe = JSON.parse(output) as ProbeOutput;
    } catch {
      throw new PermanentProcessingError('INVALID_MEDIA');
    }

    const formatName = probe.format?.format_name ?? '';
    const formats = formatName.split(',');
    if (!formats.some((format) => ALLOWED_FORMATS.includes(format))) {
      throw new PermanentProcessingError('UNSUPPORTED_CODEC');
    }

    const stream = probe.streams?.find(
      (candidate) => candidate.codec_type === 'video',
    );
    if (!stream?.codec_name) {
      throw new PermanentProcessingError('INVALID_MEDIA');
    }
    const durationSeconds = Number(
      probe.format?.duration ?? stream.duration ?? Number.NaN,
    );
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new PermanentProcessingError('INVALID_MEDIA');
    }

    const [frameNumerator, frameDenominator] = (
      stream.avg_frame_rate ||
      stream.r_frame_rate ||
      '0/1'
    )
      .split('/')
      .map(Number);
    const fps =
      frameDenominator && frameDenominator !== 0
        ? frameNumerator / frameDenominator
        : 0;
    const width = Number(stream.width);
    const height = Number(stream.height);
    if (!width || !height || !Number.isFinite(fps)) {
      throw new PermanentProcessingError('INVALID_MEDIA');
    }

    return {
      durationSeconds,
      metadata: {
        container: formatName,
        codec: stream.codec_name,
        width,
        height,
        fps,
        bitrate: Number(probe.format?.bit_rate ?? stream.bit_rate ?? 0),
      },
    };
  }
}
