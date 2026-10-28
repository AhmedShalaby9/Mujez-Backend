import { randomUUID } from "node:crypto";
import { Logger, ValidationPipe, type INestApplication } from "@nestjs/common";
import helmet from "helmet";
import type { Request, Response, NextFunction } from "express";
import type { Environment } from "../../config/env.js";
import { ApiErrorFilter } from "./api-error.filter.js";

export function configureApp(app: INestApplication, env: Environment): void {
  const server = app.getHttpAdapter().getInstance();
  server.disable("x-powered-by");
  server.set(
    "trust proxy",
    env.TRUST_PROXY_CIDRS ? env.TRUST_PROXY_CIDRS.split(",") : false,
  );
  app.use(helmet());
  app.enableCors({
    credentials: true,
    origin: env.CORS_ORIGINS.split(",").map((s) => s.trim()),
    allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
    exposedHeaders: ["X-Request-Id"],
  });
  const logger = new Logger("HTTP");
  app.use((_req: Request, res: Response, next: NextFunction) => {
    const start = performance.now();
    const requestId = randomUUID();
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("Cache-Control", "no-store");
    res.on("finish", () =>
      logger.log(
        JSON.stringify({
          requestId,
          method: _req.method,
          status: res.statusCode,
          durationMs: Math.round(performance.now() - start),
        }),
      ),
    );
    next();
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !env.CORS_ORIGINS.split(",").includes(req.headers.origin ?? "")
    ) {
      res
        .status(403)
        .json({
          code: "origin_denied",
          message: "Request origin is not allowed",
        });
      return;
    }
    next();
  });
  app.useGlobalFilters(new ApiErrorFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();
}
