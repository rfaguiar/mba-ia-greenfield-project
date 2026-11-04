import { Injectable } from '@nestjs/common';
import { access, rm, stat } from 'node:fs/promises';
import {
  PermanentProcessingError,
  TransientProcessingError,
} from '../processing.errors';
import {
  ProcessExitError,
  ProcessTimeoutError,
  runProcess,
} from './run-process';

const THUMBNAIL_TIMEOUT_MS = 120000;

@Injectable()
export class ThumbnailService {
  async render(
    filePath: string,
    durationSeconds: number,
    outputPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const offset = durationSeconds < 1 ? 0 : durationSeconds * 0.1;
    await this.renderAt(filePath, outputPath, offset, signal);
    if (!(await hasContent(outputPath))) {
      await this.renderAt(filePath, outputPath, 0, signal);
    }
    if (!(await hasContent(outputPath))) {
      throw new PermanentProcessingError('UNSUPPORTED_CODEC');
    }
  }

  private async renderAt(
    filePath: string,
    outputPath: string,
    offset: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await rm(outputPath, { force: true });
    try {
      await runProcess(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-protocol_whitelist',
          'file',
          '-ss',
          String(offset),
          '-i',
          filePath,
          '-frames:v',
          '1',
          '-vf',
          'scale=640:-2',
          '-q:v',
          '3',
          '-y',
          outputPath,
        ],
        { timeoutMs: THUMBNAIL_TIMEOUT_MS, signal },
      );
    } catch (error: unknown) {
      if (error instanceof ProcessTimeoutError) {
        throw new TransientProcessingError('ffmpeg timed out');
      }
      if (error instanceof ProcessExitError) {
        if (error.exitCode === null) {
          throw new TransientProcessingError('ffmpeg could not start');
        }
        throw new PermanentProcessingError('UNSUPPORTED_CODEC');
      }
      throw new TransientProcessingError('ffmpeg could not run');
    }
  }
}

async function hasContent(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return (await stat(filePath)).size > 0;
  } catch (error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}
