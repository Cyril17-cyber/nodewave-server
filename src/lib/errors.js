/** An error whose message is safe to show to API clients. */
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, code = "BAD_REQUEST", details) => new AppError(400, code, message, details);
export const unauthorized = (message = "Authentication required", code = "UNAUTHORIZED") =>
  new AppError(401, code, message);
export const forbidden = (message = "You don't have access to this", code = "FORBIDDEN") =>
  new AppError(403, code, message);
export const notFound = (message = "Not found", code = "NOT_FOUND") => new AppError(404, code, message);
export const conflict = (message, code = "CONFLICT") => new AppError(409, code, message);
export const unavailable = (message, code = "UNAVAILABLE") => new AppError(503, code, message);
