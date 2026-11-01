import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  Param,
  Query,
  ParseUUIDPipe,
  UseInterceptors,
  UploadedFile,
  StreamableFile,
  Res,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiConsumes, ApiBody } from "@nestjs/swagger";
import type { Response } from "express";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { DocumentsService, type UploadFile } from "./documents.service.js";
import {
  DocumentQuery,
  DocumentUpload,
  DocumentArchive,
  DocumentReview,
} from "./documents.dto.js";
@RequireAccess(["company_admin"], "documents.read")
@Controller("api/v1/documents")
export class DocumentsController {
  constructor(private readonly s: DocumentsService) {}
  @Get() list(@Req() r: AuthRequest, @Query() q: DocumentQuery) {
    return this.s.list(r.principal, q);
  }
  @Get(":id") detail(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.s.detail(r.principal, id);
  }
  @Get(":id/download") async download(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const d = await this.s.download(r.principal, id);
    const name = encodeURIComponent(d.name).replace(
      /['()*]/g,
      (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase(),
    );
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=\"document.bin\"; filename*=UTF-8''" + name,
    );
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", d.content.length);
    return new StreamableFile(d.content);
  }
  @Post(":id/review")
  @RequireAccess(["company_admin"], "documents.manage")
  review(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: DocumentReview,
  ) {
    return this.s.review(r.principal, id, b);
  }
  @Get(":id/preview") async preview(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const d = await this.s.download(r.principal, id);
    const safe = [
      "application/pdf",
      "image/png",
      "image/jpeg",
      "text/plain",
    ].includes(d.mime);
    res.setHeader("Content-Type", safe ? d.mime : "application/octet-stream");
    res.setHeader("Content-Disposition", safe ? "inline" : "attachment");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Length", d.content.length);
    return new StreamableFile(d.content);
  }
  @Post()
  @RequireAccess(["company_admin"], "documents.manage")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 5242880, files: 1, fields: 10, fieldSize: 4000 },
    }),
  )
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["requestId", "kind", "title", "file"],
      properties: {
        requestId: { type: "string", format: "uuid" },
        kind: { type: "string" },
        title: { type: "string" },
        leadId: { type: "string", format: "uuid" },
        contractId: { type: "string", format: "uuid" },
        expiresDate: { type: "string", format: "date" },
        file: { type: "string", format: "binary" },
      },
    },
  })
  upload(
    @Req() r: AuthRequest,
    @Body() b: DocumentUpload,
    @UploadedFile() file: UploadFile | undefined,
  ) {
    return this.s.upload(r.principal, b, file);
  }
  @Post(":id/archive")
  @RequireAccess(["company_admin"], "documents.manage")
  archive(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: DocumentArchive,
  ) {
    return this.s.archive(r.principal, id, b);
  }
}
