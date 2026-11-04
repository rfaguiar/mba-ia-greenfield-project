export const VIDEO_PROCESSING_QUEUE = Symbol('VIDEO_PROCESSING_QUEUE');

export interface VideoProcessingQueue {
  requestProcessing(videoId: string, attempt?: number): Promise<void>;
  scheduleRetry(videoId: string, attempt: number): Promise<void>;
}
