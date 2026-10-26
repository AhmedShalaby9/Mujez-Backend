import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from "@nestjs/common";
import type { Response, Request } from "express";

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiErrorFilter.name);
  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();
    const status = error instanceof HttpException ? error.getStatus() : 500;
    const body =
      error instanceof HttpException ? error.getResponse() : undefined;
    const detail =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>)
        : {};
    const codes: Record<number, string> = {
      400: "validation_failed",
      401: "unauthenticated",
      403: "permission_denied",
      404: "not_found",
      409: "conflict",
      429: "rate_limited",
      503: "service_unavailable",
    };
    if (status >= 500)
      this.logger.error(
        JSON.stringify({
          requestId: response.getHeader("X-Request-Id"),
          status,
          method: request.method,
          errorType: error instanceof Error ? error.name : "Unknown",
        }),
      );
    response.status(status).json({
      code: detail.code ?? codes[status] ?? "internal_error",
      message:
        status >= 500
          ? "Service temporarily unavailable"
          : (detail.message ?? "Request could not be completed"),
      ...(detail.field ? { field: detail.field } : {}),
      ...(detail.permission ? { permission: detail.permission } : {}),
    });
  }
}
