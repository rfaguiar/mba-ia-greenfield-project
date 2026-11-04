export class PermanentProcessingError extends Error {
  constructor(public readonly code: 'INVALID_MEDIA' | 'UNSUPPORTED_CODEC') {
    super(code);
    this.name = PermanentProcessingError.name;
  }
}

export class TransientProcessingError extends Error {
  constructor(message = 'Transient video processing failure') {
    super(message);
    this.name = TransientProcessingError.name;
  }
}
