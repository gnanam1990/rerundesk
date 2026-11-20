export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export const badRequest = (code, msg, d) => new HttpError(400, code, msg, d);
export const unauthorized = (msg = "authentication required", code = "UNAUTHORIZED") =>
  new HttpError(401, code, msg);
export const forbidden = (msg = "forbidden", code = "FORBIDDEN") =>
  new HttpError(403, code, msg);
export const notFound = (msg = "not found") => new HttpError(404, "NOT_FOUND", msg);
export const conflict = (code, msg, d) => new HttpError(409, code, msg, d);
export const unprocessable = (code, msg, d) => new HttpError(422, code, msg, d);
