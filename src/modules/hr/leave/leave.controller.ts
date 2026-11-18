import {
  Controller,
  Get,
  Post,
  Req,
  Query,
  Body,
  Param,
  ParseUUIDPipe,
  UseInterceptors,
  UploadedFile,
  StreamableFile,
  Res,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import type { UploadFile } from "../../finance/documents/documents.service.js";
import { LeaveService } from "./leave.service.js";
@Controller("api/v1/leave")
@RequireAccess(["company_admin", "company_user"])
export class LeaveController {
  constructor(private readonly s: LeaveService) {}
  @Get("context") context(@Req() r: AuthRequest) {
    return this.s.context(r.principal);
  }
  @Get("policy") policy(@Req() r: AuthRequest) {
    return this.s.policy(r.principal);
  }
  @Post("policy") policySave(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.savePolicy(r.principal, b);
  }
  @Get("options") options(@Req() r: AuthRequest) {
    return this.s.targets(r.principal);
  }
  @Get("balance") balance(
    @Req() r: AuthRequest,
    @Query() q: Record<string, string>,
  ) {
    const b = this.s.parseQuery(q);
    return this.s.balance(r.principal, b.employeeId, b.year);
  }
  @Get("balances") balances(
    @Req() r: AuthRequest,
    @Query() q: Record<string, string>,
  ) {
    return this.s.balances(r.principal, q);
  }
  @Post("balances") balanceSave(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.adjustBalance(r.principal, b);
  }
  @Get("requests") list(
    @Req() r: AuthRequest,
    @Query() q: Record<string, string>,
  ) {
    return this.s.list(r.principal, q);
  }
  @Post("requests") create(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.create(r.principal, b);
  }
  @Post("requests/:id/action") action(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.act(r.principal, id, b);
  }
  @Get("requests/:id/history") history(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.s.history(r.principal, id);
  }
  @Get("calendar") calendar(
    @Req() r: AuthRequest,
    @Query() q: Record<string, string>,
  ) {
    return this.s.calendar(r.principal, q);
  }
  @Post("requests/:id/attachment")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 5242880, files: 1, fields: 4, fieldSize: 4000 },
    }),
  )
  upload(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
    @UploadedFile() file: UploadFile | undefined,
  ) {
    return this.s.upload(r.principal, id, b, file);
  }
  @Get("requests/:id/attachment") async download(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const f = await this.s.download(r.principal, id);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="attachment.bin"; filename*=UTF-8''${encodeURIComponent(f.name).replace(/['()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16))}`,
    );
    return new StreamableFile(f.content);
  }
}
