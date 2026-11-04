import { S3Client } from '@aws-sdk/client-s3';
import { StorageUnavailableException } from '../common/exceptions/domain.exception';
import { StorageService } from './storage.service';

const settings = {
  bucketVideos: 'videos',
  bucketThumbnails: 'thumbnails',
  presignExpirySeconds: 3600,
};

function makeService(send: jest.Mock): StorageService {
  return new StorageService(
    { send } as unknown as S3Client,
    {} as S3Client,
    settings as ConstructorParameters<typeof StorageService>[2],
  );
}

describe('StorageService', () => {
  it('wraps unexpected S3 errors in StorageUnavailableException', async () => {
    const service = makeService(
      jest.fn().mockRejectedValue(new Error('offline')),
    );

    await expect(
      service.createMultipartUpload('key', 'video/mp4'),
    ).rejects.toBeInstanceOf(StorageUnavailableException);
  });

  it('treats a missing multipart upload as already aborted', async () => {
    const error = Object.assign(new Error('gone'), { name: 'NoSuchUpload' });
    const service = makeService(jest.fn().mockRejectedValue(error));

    await expect(
      service.abortMultipartUpload('key', 'upload-id'),
    ).resolves.toBeUndefined();
  });

  it('returns null when HeadObject reports a missing object', async () => {
    const error = Object.assign(new Error('missing'), { name: 'NotFound' });
    const service = makeService(jest.fn().mockRejectedValue(error));

    await expect(service.headObject('videos', 'key')).resolves.toBeNull();
  });

  it('lists every uploaded part using advancing S3 pagination markers', async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce({
        IsTruncated: true,
        NextPartNumberMarker: '1',
        Parts: [{ PartNumber: 1, ETag: '"one"', Size: 5 }],
      })
      .mockResolvedValueOnce({
        IsTruncated: false,
        Parts: [{ PartNumber: 2, ETag: '"two"', Size: 7 }],
      });
    const service = makeService(send);

    await expect(
      service.listUploadedParts('key', 'upload-id'),
    ).resolves.toEqual([
      { partNumber: 1, etag: '"one"', size: 5 },
      { partNumber: 2, etag: '"two"', size: 7 },
    ]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].input.PartNumberMarker).toBe('1');
  });

  it('rejects a truncated ListParts response without an advancing marker', async () => {
    const service = makeService(
      jest.fn().mockResolvedValue({
        IsTruncated: true,
        Parts: [{ PartNumber: 1, ETag: '"one"', Size: 5 }],
      }),
    );

    await expect(
      service.listUploadedParts('key', 'upload-id'),
    ).rejects.toBeInstanceOf(StorageUnavailableException);
  });
});
