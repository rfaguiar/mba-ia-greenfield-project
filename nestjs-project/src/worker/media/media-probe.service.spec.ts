import { PermanentProcessingError } from '../processing.errors';
import { runProcess } from './run-process';
import { MediaProbeService } from './media-probe.service';

jest.mock('./run-process', () => ({
  ...jest.requireActual('./run-process'),
  runProcess: jest.fn(),
}));

const probeProcess = jest.mocked(runProcess);

describe('MediaProbeService', () => {
  const service = new MediaProbeService();

  beforeEach(() => {
    probeProcess.mockReset();
  });

  it('extracts duration, frame rate, and curated metadata', async () => {
    probeProcess.mockResolvedValue(
      JSON.stringify({
        format: {
          format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
          duration: '2.0',
          bit_rate: '1200',
          tags: { title: 'private metadata' },
        },
        streams: [
          {
            codec_type: 'video',
            codec_name: 'h264',
            width: 320,
            height: 240,
            avg_frame_rate: '25/1',
          },
        ],
      }),
    );

    await expect(service.probe('sample.mp4')).resolves.toEqual({
      durationSeconds: 2,
      metadata: {
        container: 'mov,mp4,m4a,3gp,3g2,mj2',
        codec: 'h264',
        width: 320,
        height: 240,
        fps: 25,
        bitrate: 1200,
      },
    });
  });

  it('falls back to the video stream duration', async () => {
    probeProcess.mockResolvedValue(
      JSON.stringify({
        format: { format_name: 'webm' },
        streams: [
          {
            codec_type: 'video',
            codec_name: 'vp9',
            width: 640,
            height: 360,
            avg_frame_rate: '30/1',
            duration: '1.5',
          },
        ],
      }),
    );

    await expect(service.probe('sample.webm')).resolves.toMatchObject({
      durationSeconds: 1.5,
    });
  });

  it('classifies missing video streams and unsupported containers', async () => {
    probeProcess.mockResolvedValueOnce(
      JSON.stringify({
        format: { format_name: 'mp4', duration: '1' },
        streams: [],
      }),
    );
    await expect(service.probe('bad.mp4')).rejects.toMatchObject({
      code: 'INVALID_MEDIA',
    });

    probeProcess.mockResolvedValueOnce(
      JSON.stringify({
        format: { format_name: 'avi', duration: '1' },
        streams: [
          {
            codec_type: 'video',
            codec_name: 'mpeg4',
            width: 320,
            height: 240,
            avg_frame_rate: '25/1',
          },
        ],
      }),
    );
    await expect(service.probe('unsupported.avi')).rejects.toBeInstanceOf(
      PermanentProcessingError,
    );
  });
});
