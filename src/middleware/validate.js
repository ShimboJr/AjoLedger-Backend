/**
 * validate(schema) — zod validation middleware.
 * Validates req.body against the provided zod schema.
 * Returns 422 with {error:{code,message,details}} on failure.
 */
export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const details = result.error.issues.map((i) => ({
        field: i.path.join('.'),
        message: i.message,
      }));
      return res.status(422).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request data',
          details,
        },
      });
    }
    req.body = result.data; // replace with coerced/transformed data
    next();
  };
}
