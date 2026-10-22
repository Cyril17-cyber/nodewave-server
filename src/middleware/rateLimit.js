import { rateLimit } from "express-rate-limit";
import { config } from "../config.js";

const limiter = (windowMinutes, limit) =>
  rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: () => config.isTest,
    message: { message: "Too many requests. Please try again later.", code: "RATE_LIMITED" },
  });

/** Login, sign-up, codes and password resets. */
export const authLimiter = limiter(15, 20);
/** Endpoints that send email. */
export const emailLimiter = limiter(60, 5);
/** File uploads. */
export const uploadLimiter = limiter(60, 100);
