import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { badRequest, payloadTooLarge, unsupportedMediaType } from "../errors.js";
import { EVENT_SOURCE_BODY_LIMIT } from "../http/body-limits.js";

type BodyParserError = Error & { status?: number; type?: string };

const EVENT_SOURCE_BODY_LIMIT_BYTES = 64 * 1024;

/**
 * Bounds unauthenticated event ingress to 64 KB before the global 10 MB parser
 * sees the request, and keeps the exact bytes the sender signed in `rawBody`.
 * A declared oversized body is rejected before it is read.
 */
export function eventSourceBodyParser(captureRawBody: (req: Request, res: Response, buf: Buffer) => void): RequestHandler {
  const jsonParser = express.json({
    limit: EVENT_SOURCE_BODY_LIMIT,
    inflate: false,
    type: "application/json",
    verify: captureRawBody,
  });
  return (req: Request, res: Response, next: NextFunction) => {
    const declared = req.headers["content-length"];
    if (typeof declared === "string" && /^\d+$/.test(declared) && Number(declared) > EVENT_SOURCE_BODY_LIMIT_BYTES) {
      req.resume();
      next(payloadTooLarge("Event body is too large", { code: "event_body_too_large", maxBytes: EVENT_SOURCE_BODY_LIMIT_BYTES }));
      return;
    }
    jsonParser(req, res, (error?: unknown) => {
      if (!error) {
        next();
        return;
      }
      const parserError = error as BodyParserError;
      if (parserError.status === 413 || parserError.type === "entity.too.large") {
        next(payloadTooLarge("Event body is too large", { code: "event_body_too_large", maxBytes: EVENT_SOURCE_BODY_LIMIT_BYTES }));
        return;
      }
      if (parserError.type === "encoding.unsupported") {
        next(unsupportedMediaType("Encoded event bodies are not supported"));
        return;
      }
      if (parserError.type === "entity.parse.failed" || parserError instanceof SyntaxError) {
        next(badRequest("Event body must be valid JSON"));
        return;
      }
      next(error);
    });
  };
}
