import { badRequest } from "../lib/errors.js";

/**
 * Validates and replaces req.body / req.query / req.params with the parsed values.
 * Usage: validate({ body: schema, params: schema })
 */
export const validate = (schemas) => (req, _res, next) => {
  for (const [part, schema] of Object.entries(schemas)) {
    const result = schema.safeParse(req[part] ?? {});
    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        path: [part, ...issue.path].join("."),
        message: issue.message,
      }));
      return next(badRequest(details[0].message, "VALIDATION_ERROR", details));
    }
    // req.query is a getter in Express 5, so it can't be reassigned
    Object.defineProperty(req, part, { value: result.data, writable: true, configurable: true });
  }
  next();
};
