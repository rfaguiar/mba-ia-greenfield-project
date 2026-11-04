import { Repository } from 'typeorm';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoLifecycleService } from './video-lifecycle.service';

function createRepository(affected = 1) {
  const query = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    returning: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected, raw: [] }),
  };
  const repository = {
    createQueryBuilder: jest.fn().mockReturnValue(query),
    create: jest.fn((value) => value),
  };
  return { query, repository };
}

describe('VideoLifecycleService', () => {
  it.each([
    ['true', 1, true],
    ['false', 0, false],
  ])(
    'maps affected rows to transition success (%s)',
    async (_, affected, expected) => {
      const { repository } = createRepository(affected);
      const service = new VideoLifecycleService(
        repository as unknown as Repository<Video>,
      );

      await expect(service.startProcessing('video-id')).resolves.toBe(expected);
    },
  );

  it('guards transitions by the expected state and stores fixed user-safe errors', async () => {
    const { query, repository } = createRepository();
    const service = new VideoLifecycleService(
      repository as unknown as Repository<Video>,
    );

    await service.failDraft('video-id', 'UPLOAD_ABORTED');

    expect(query.where).toHaveBeenCalledWith(
      'id = :id AND status = :expected',
      { id: 'video-id', expected: VideoStatus.DRAFT },
    );
    expect(query.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: VideoStatus.ERROR,
        error_code: 'UPLOAD_ABORTED',
        error_message: 'The upload was cancelled',
      }),
    );
  });

  it('maps an empty claim RETURNING result to null', async () => {
    const { query, repository } = createRepository();
    const service = new VideoLifecycleService(
      repository as unknown as Repository<Video>,
    );

    await expect(service.claim('video-id', 1000)).resolves.toBeNull();
    expect(query.returning).toHaveBeenCalledWith('*');
  });

  it('returns the claimed row and includes an incremented processing counter', async () => {
    const { query, repository } = createRepository();
    query.execute.mockResolvedValue({
      affected: 1,
      raw: [{ id: 'video-id', processing_attempts: 1 }],
    });
    const service = new VideoLifecycleService(
      repository as unknown as Repository<Video>,
    );

    await expect(service.claim('video-id', 1000)).resolves.toMatchObject({
      id: 'video-id',
      processing_attempts: 1,
    });
  });
});
