import multer from "multer";
import { AppError } from "../lib/errors.js";

export function notFoundHandler(req, res) {
  res.status(404).json({ message: `No route for ${req.method} ${req.path}`, code: "NOT_FOUND" });
}

// Express 5 forwards rejected promises from async handlers here, so no route can crash the process.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ message: err.message, code: err.code, details: err.details });
  }
  if (err instanceof multer.MulterError) {
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(status).json({ message: err.message, code: err.code });
  }
  // http-errors from Express itself (e.g. express.static 404s, range errors)
  if (err.expose && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ message: err.message, code: err.status === 404 ? "NOT_FOUND" : "BAD_REQUEST" });
  }
  if (err.code === "23505") {
    // Postgres unique violation, e.g. two requests racing to create the same row
    return res.status(409).json({ message: "That already exists.", code: "CONFLICT" });
  }
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ message: "Malformed JSON body", code: "BAD_REQUEST" });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({ message: "Request body too large", code: "PAYLOAD_TOO_LARGE" });
  }
  console.error(`${req.method} ${req.originalUrl} failed:`, err);
  res.status(500).json({ message: "Server error. Please try again.", code: "INTERNAL" });
}
