import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import storageConfig from '../config/storage.config';
import { StorageUnavailableException } from '../common/exceptions/domain.exception';

export const S3_CLIENT = Symbol('S3_CLIENT');
export const S3_PRESIGN_CLIENT = Symbol('S3_PRESIGN_CLIENT');

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface PresignedPart {
  partNumber: number;
  url: string;
}

@Injectable()
export class StorageService {
  constructor(
    @Inject(S3_CLIENT) private readonly client: S3Client,
    @Inject(S3_PRESIGN_CLIENT) private readonly presignClient: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    try {
      const result = await this.client.send(
        new CreateMultipartUploadCommand({
          Bucket: this.config.bucketVideos,
          Key: key,
          ContentType: contentType,
        }),
      );
      if (!result.UploadId) throw new Error('S3 returned no upload id');
      return result.UploadId;
    } catch {
      throw new StorageUnavailableException();
    }
  }

  async listUploadedParts(
    key: string,
    uploadId: string,
  ): Promise<UploadedPart[]> {
    try {
      const parts: UploadedPart[] = [];
      let marker: string | undefined;
      while (true) {
        const page = await this.client.send(
          new ListPartsCommand({
            Bucket: this.config.bucketVideos,
            Key: key,
            UploadId: uploadId,
            MaxParts: 1000,
            ...(marker !== undefined && { PartNumberMarker: marker }),
          }),
        );
        for (const part of page.Parts ?? []) {
          if (part.PartNumber !== undefined && part.ETag) {
            parts.push({
              partNumber: part.PartNumber,
              etag: part.ETag,
              size: part.Size ?? 0,
            });
          }
        }
        if (!page.IsTruncated) break;
        const nextMarker = page.NextPartNumberMarker;
        const numericNextMarker = Number(nextMarker);
        if (
          nextMarker === undefined ||
          !Number.isInteger(numericNextMarker) ||
          numericNextMarker <= Number(marker ?? 0)
        ) {
          throw new Error('S3 returned an invalid ListParts pagination marker');
        }
        marker = nextMarker;
      }
      return parts;
    } catch (error) {
      if (isNoSuchUpload(error)) throw error;
      throw new StorageUnavailableException();
    }
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<void> {
    try {
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.config.bucketVideos,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map(({ partNumber, etag }) => ({
              PartNumber: partNumber,
              ETag: etag,
            })),
          },
        }),
      );
    } catch (error) {
      if (isNoSuchUpload(error)) throw error;
      throw new StorageUnavailableException();
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.config.bucketVideos,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (error) {
      if (!isNoSuchUpload(error)) throw new StorageUnavailableException();
    }
  }

  async headObject(
    bucket: string,
    key: string,
  ): Promise<{ contentLength: number } | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
      );
      return { contentLength: result.ContentLength ?? 0 };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new StorageUnavailableException();
    }
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: key }),
      );
    } catch {
      throw new StorageUnavailableException();
    }
  }

  async presignUploadParts(
    key: string,
    uploadId: string,
    partNumbers: number[],
  ): Promise<{ expiresAt: Date; parts: PresignedPart[] }> {
    try {
      const expiresAt = new Date(
        Date.now() + this.config.presignExpirySeconds * 1000,
      );
      const parts = await Promise.all(
        partNumbers.map(async (partNumber) => ({
          partNumber,
          url: await getSignedUrl(
            this.presignClient,
            new UploadPartCommand({
              Bucket: this.config.bucketVideos,
              Key: key,
              UploadId: uploadId,
              PartNumber: partNumber,
            }),
            { expiresIn: this.config.presignExpirySeconds },
          ),
        })),
      );
      return { expiresAt, parts };
    } catch {
      throw new StorageUnavailableException();
    }
  }

  async presignGetObject(
    bucket: string,
    key: string,
    responseContentDisposition?: string,
  ): Promise<{ url: string; expiresAt: Date }> {
    try {
      return {
        url: await getSignedUrl(
          this.presignClient,
          new GetObjectCommand({
            Bucket: bucket,
            Key: key,
            ...(responseContentDisposition && {
              ResponseContentDisposition: responseContentDisposition,
            }),
          }),
          { expiresIn: this.config.presignExpirySeconds },
        ),
        expiresAt: new Date(
          Date.now() + this.config.presignExpirySeconds * 1000,
        ),
      };
    } catch {
      throw new StorageUnavailableException();
    }
  }

  async downloadToFile(
    bucket: string,
    key: string,
    filePath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { abortSignal: signal },
      );
      if (!result.Body) throw new Error('S3 returned an empty object body');
      await pipeline(result.Body as Readable, createWriteStream(filePath), {
        signal,
      });
    } catch {
      throw new StorageUnavailableException();
    }
  }

  async uploadFile(
    bucket: string,
    key: string,
    filePath: string,
    contentType: string,
  ): Promise<void> {
    try {
      const fileStat = await stat(filePath);
      await this.client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: createReadStream(filePath),
          ContentLength: fileStat.size,
          ContentType: contentType,
        }),
      );
    } catch {
      throw new StorageUnavailableException();
    }
  }
}

function isNoSuchUpload(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'NoSuchUpload'
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error.name === 'NotFound' || error.name === 'NoSuchKey')
  );
}
