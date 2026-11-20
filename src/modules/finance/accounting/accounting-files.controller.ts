import {
  Controller,
  Get,
  Post,
  Req,
  Body,
  Param,
  ParseUUIDPipe,
  UploadedFile,
  UseInterceptors,
  Res,
  StreamableFile,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import type { UploadFile } from "../documents/documents.service.js";
import { AccountingFilesService } from "./accounting-files.service.js";
@Controller("api/v1/accounting")
@RequireAccess(["company_admin", "company_user"])
export class AccountingFilesController {
  constructor(readonly s: AccountingFilesService) {}
  @Get("files/:kind/:id") list(
    @Req() r: AuthRequest,
    @Param("kind") kind: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.s.list(r.principal, kind, id);
  }
  @Post("files/:kind/:id")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 5242880, files: 1, fields: 1, fieldSize: 100 },
    }),
  )
  upload(
    @Req() r: AuthRequest,
    @Param("kind") kind: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
    @UploadedFile() file: UploadFile,
  ) {
    return this.s.upload(r.principal, kind, id, b, file);
  }
  @Get("attachments/:id/download") async download(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const f = await this.s.download(r.principal, id);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="document.bin"; filename*=UTF-8''${encodeURIComponent(f.name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16))}`,
    );
    return new StreamableFile(f.content);
  }
  @Get("print/:kind/:id") async print(
    @Req() r: AuthRequest,
    @Param("kind") kind: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const f = await this.s.print(r.principal, kind, id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="' + f.name + '"',
    );
    return new StreamableFile(f.content);
  }
}
