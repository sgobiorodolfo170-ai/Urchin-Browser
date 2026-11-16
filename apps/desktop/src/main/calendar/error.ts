export class CalendarError extends Error {
  constructor(
    readonly code:
      | 'NOT_FOUND'
      | 'VERSION_CONFLICT'
      | 'INVALID_ARGUMENT'
      | 'UNSUPPORTED_FEATURE'
      | 'IDEMPOTENCY_CONFLICT',
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}
