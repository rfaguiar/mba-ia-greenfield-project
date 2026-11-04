import { registerAs } from '@nestjs/config';

export default registerAs('worker', () => ({
  scratchDir: process.env.WORKER_SCRATCH_DIR || '/tmp/streamtube-worker',
  videoDraftTtlHours: Number(process.env.VIDEO_DRAFT_TTL_HOURS || 24),
}));
