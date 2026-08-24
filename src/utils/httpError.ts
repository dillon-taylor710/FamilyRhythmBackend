// A typed, expected error the error-handling middleware knows how to
// render safely (status + message to the client). Anything thrown that
// ISN'T an HttpError is treated as a bug and logged with full detail but
// returned to the client as an opaque 500 — never leak internals like DB
// errors or stack traces to API callers.
export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, message, details);
export const unauthorized = (message = 'Unauthorized') => new HttpError(401, message);
export const forbidden = (message = 'Forbidden') => new HttpError(403, message);
export const notFound = (message = 'Not found') => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);
