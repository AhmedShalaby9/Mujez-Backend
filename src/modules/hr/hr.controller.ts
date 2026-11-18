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
import type { Response } from "express";
import { RequireAccess } from "../../common/auth/access.js";
import type { AuthRequest } from "../../common/auth/access.guard.js";
import type { UploadFile } from "../finance/documents/documents.service.js";
import { HrService } from "./hr.service.js";
@Controller("api/v1/hr")
@RequireAccess(["company_admin"], "workspace.view")
export class HrController {
  constructor(private readonly s: HrService) {}
  @Get("overview") overview(@Req() r: AuthRequest) {
    return this.s.overview(r.principal);
  }
  @Get("options") options(@Req() r: AuthRequest) {
    return this.s.options(r.principal);
  }
  @Get("employees") employees(
    @Req() r: AuthRequest,
    @Query() q: Record<string, string>,
  ) {
    return this.s.list(r.principal, "employees", q);
  }
  @Post("employees") employeeCreate(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.saveEmployee(r.principal, b);
  }
  @Post("employees/:id") employeeUpdate(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.saveEmployee(r.principal, b, id);
  }
  @Get("departments") departments(
    @Req() r: AuthRequest,
    @Query() q: Record<string, string>,
  ) {
    return this.s.list(r.principal, "departments", q);
  }
  @Post("departments") departmentCreate(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.saveDepartment(r.principal, b);
  }
  @Post("departments/:id") departmentUpdate(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.saveDepartment(r.principal, b, id);
  }
  @Get("onboarding") tasks(
    @Req() r: AuthRequest,
    @Query() q: Record<string, string>,
  ) {
    return this.s.list(r.principal, "onboarding", q);
  }
  @Post("onboarding") taskCreate(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.saveTask(r.principal, b);
  }
  @Post("onboarding/:id") taskUpdate(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.saveTask(r.principal, b, id);
  }
  @Get("documents") documents(
    @Req() r: AuthRequest,
    @Query() q: Record<string, string>,
  ) {
    return this.s.list(r.principal, "documents", q);
  }
  @Post("documents")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 5242880, files: 1, fields: 8, fieldSize: 4000 },
    }),
  )
  upload(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
    @UploadedFile() f: UploadFile | undefined,
  ) {
    return this.s.upload(r.principal, b, f);
  }
  @Post("documents/:id/archive") archive(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.archive(r.principal, id, b);
  }
  @Get("documents/:id/download") async download(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const f = await this.s.download(r.principal, id);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="document.bin"; filename*=UTF-8''${encodeURIComponent(f.name).replace(/['()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16))}`,
    );
    return new StreamableFile(f.content);
  }
}
