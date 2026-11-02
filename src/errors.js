// Consistent error shape across every route: res.json({ error: "message" }).
export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (message, details) => new ApiError(400, message, details);
export const unauthorized = (message = "Please sign in to continue.") =>
  new ApiError(401, message);
export const forbidden = (message = "You don't have access to this resource.") =>
  new ApiError(403, message);
export const notFound = (message = "Resource not found.") => new ApiError(404, message);
export const conflict = (message) => new ApiError(409, message);
