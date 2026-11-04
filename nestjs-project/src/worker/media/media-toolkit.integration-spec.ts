import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermanentProcessingError } from '../processing.errors';
import { MediaProbeService } from './media-probe.service';
import { runProcess } from './run-process';
import { ThumbnailService } from './thumbnail.service';

describe('media toolkit (integration)', () => {
  const fixtureDirectory = join(process.cwd(), 'test', 'fixtures', 'videos');
  const samplePath = join(fixtureDirectory, 'sample-2s.mp4');
  const invalidPath = join(fixtureDirectory, 'not-a-video.mp4');
  let scratchDirectory: string;

  beforeAll(async () => {
    scratchDirectory = await mkdtemp(join(tmpdir(), 'streamtube-media-'));
  });

  afterAll(async () => {
    await rm(scratchDirectory, { recursive: true, force: true });
  });

  it('probes the fixture and returns only curated metadata', async () => {
    const probe = new MediaProbeService();

    const result = await probe.probe(samplePath);

    expect(result.durationSeconds).toBeGreaterThanOrEqual(1.9);
    expect(result.durationSeconds).toBeLessThanOrEqual(2.1);
    expect(result.metadata).toMatchObject({
      codec: 'h264',
      width: 320,
      height: 240,
      fps: 25,
    });
    expect(Object.keys(result.metadata).sort()).toEqual(
      ['bitrate', 'codec', 'container', 'fps', 'height', 'width'].sort(),
    );
  });

  it('renders a 640-pixel-wide JPEG thumbnail', async () => {
    const outputPath = join(scratchDirectory, 'thumbnail.jpg');
    const thumbnail = new ThumbnailService();
    const probe = await new MediaProbeService().probe(samplePath);

    await thumbnail.render(samplePath, probe.durationSeconds, outputPath);

    const output = await runProcess(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        outputPath,
      ],
      { timeoutMs: 10000 },
    );
    expect(Number(output.trim())).toBe(640);
    expect((await stat(outputPath)).size).toBeGreaterThan(0);
  });

  it('classifies random bytes as permanent invalid media', async () => {
    await expect(
      new MediaProbeService().probe(invalidPath),
    ).rejects.toMatchObject({
      code: 'INVALID_MEDIA',
    } satisfies Partial<PermanentProcessingError>);
  });
});
