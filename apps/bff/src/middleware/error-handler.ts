import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { createLogger, describeError } from '../logger.js';

const log = createLogger('http');

/**
 * The default answer for an unhandled route failure: logged here, `{ error }` to
 * the client. Every read route relies on it rather than repeating a
 * log-and-500 catch block; the exceptions are routes where the response is not a
 * plain JSON 500, and they say so where they are.
 *
 * Also the reason `next(err)` is safe. Without this, anything reaching it — the
 * only failure path `resolveAthleteId` has — falls through to Express's built-in
 * handler and answers with an HTML stack page, breaking the `{ error }` contract
 * the frontend parses at exactly the moment identity resolution fails.
 *
 * Mount last, after all routers.
 */
export function jsonErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Express only treats a 4-arity function as an error handler, so `next` must
  // stay in the signature even though the delegation case is rare.
  if (res.headersSent) {
    next(err);
    return;
  }

  log.error('Unhandled route error', { method: req.method, path: req.path, ...describeError(err) });

  // The message is deliberately fixed: the log above keeps the detail, and the
  // client has no use for an internal failure string.
  res.status(500).json({ error: 'Internal server error' });
}

/**
 * Forwards a rejected async handler to the error handler above.
 *
 * Express 4 does not await route handlers, so a rejected promise becomes an
 * unhandled rejection and the request hangs until the client gives up — which is
 * why every route that drops its own try/catch has to be wrapped in this. (In
 * Express 5 this becomes unnecessary and can be deleted.)
 */
export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

/** 404 for unmatched /api routes, so they answer JSON rather than Express's HTML default. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
}
