import { FileInterceptor } from "@nestjs/platform-express";
import {
  UseInterceptors,
  UploadedFile,
  Res,
  StreamableFile,
} from "@nestjs/common";
import type { Response } from "express";
import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Query,
  Param,
  ParseUUIDPipe,
  BadRequestException,
} from "@nestjs/common";
import { ApiOperation } from "@nestjs/swagger";
import { RequireAccess } from "../../common/auth/access.js";
import type { AuthRequest } from "../../common/auth/access.guard.js";
import { OfficeService } from "./office.service.js";
import { OfficeWrite } from "./office.dto.js";
@RequireAccess(["company_admin", "company_user"], "leads.read")
@Controller("api/v1/office")
export class OfficeController {
  constructor(private readonly s: OfficeService) {}
  @Get("options") options(@Req() r: AuthRequest) {
    return this.s.options(r.principal);
  }
  @Get("clients") clients(
    @Req() r: AuthRequest,
    @Query() q: Record<string, string>,
  ) {
    return this.s.list(r.principal, "clients", q);
  }
  @Get("properties") properties(
    @Req() r: AuthRequest,
    @Query() q: Record<string, string>,
  ) {
    return this.s.list(r.principal, "properties", q);
  }
  @Get("deals") deals(
    @Req() r: AuthRequest,
    @Query() q: Record<string, string>,
  ) {
    return this.s.list(r.principal, "deals", q);
  }
  @Get("clients/:id") client(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.s.detail(r.principal, "clients", id);
  }
  @Get("properties/:id") property(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.s.detail(r.principal, "properties", id);
  }
  @Post("clients") createClient(@Req() r: AuthRequest, @Body() b: OfficeWrite) {
    return this.s.saveClient(r.principal, b);
  }
  @Post("clients/:id") updateClient(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: OfficeWrite,
  ) {
    return this.s.saveClient(r.principal, b, id);
  }
  @Post("properties") createProperty(
    @Req() r: AuthRequest,
    @Body() b: OfficeWrite,
  ) {
    return this.s.saveProperty(r.principal, b);
  }
  @Post("properties/:id") updateProperty(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: OfficeWrite,
  ) {
    return this.s.saveProperty(r.principal, b, id);
  }
  @Post("clients/:id/activities") activity(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: OfficeWrite,
  ) {
    return this.s.activity(r.principal, id, b);
  }
  @Post("bookings") book(@Req() r: AuthRequest, @Body() b: OfficeWrite) {
    return this.s.book(r.principal, b);
  }
  @Post("deals/:id") dealAction(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: OfficeWrite,
  ) {
    return this.s.dealAction(r.principal, id, b);
  }
  @Get("clients/:id/recommendations")
  @ApiOperation({
    summary: "Office stock matching with an explicit 10% budget ceiling",
    description:
      "Uses saved client needs, company-only stock, exact EGP minor amounts and current permissions. No external AI call or charge.",
  })
  recommendations(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Query("purpose") purpose: string,
  ) {
    if (!["sale", "rent"].includes(purpose))
      throw new BadRequestException("Choose sale or rent");
    return this.s.recommendations(r.principal, id, purpose as "sale" | "rent");
  }
  @Get("filters") filters(@Req() r: AuthRequest, @Query("view") view: string) {
    return this.s.filters(r.principal, view);
  }
  @Post("filters") saveFilter(@Req() r: AuthRequest, @Body() b: OfficeWrite) {
    return this.s.saveFilter(r.principal, b);
  }
  @Post("media")
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 5242880, files: 1 } }),
  )
  upload(
    @Req() r: AuthRequest,
    @UploadedFile() file: any,
    @Body() fields: Record<string, string>,
  ) {
    return this.s.upload(r.principal, file, fields);
  }
  @Get("media/:id") async media(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const file = await this.s.media(r.principal, id);
    res.setHeader("Content-Type", file.mime);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (file.kind === "contract")
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="contract.pdf"',
      );
    return new StreamableFile(file.bytes);
  }
}
