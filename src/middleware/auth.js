import { unauthorized } from "../lib/errors.js";
import { verifyAccessToken } from "../lib/tokens.js";

function bearerToken(req) {
  const header = req.get("authorization") || "";
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : null;
}

/** Rejects the request unless it carries a valid access token; sets req.userId and req.sessionId. */
export function requireAuth(req, _res, next) {
  const token = bearerToken(req);
  if (!token) return next(unauthorized());
  ({ userId: req.userId, sessionId: req.sessionId } = verifyAccessToken(token));
  next();
}

/** Sets req.userId when a valid token is present, but lets anonymous requests through. */
export function optionalAuth(req, _res, next) {
  const token = bearerToken(req);
  if (token) req.userId = verifyAccessToken(token).userId;
  next();
}
