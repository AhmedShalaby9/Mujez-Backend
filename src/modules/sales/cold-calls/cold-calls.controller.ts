import {
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiProduces,
} from "@nestjs/swagger";
import {
  Controller,
  Get,
  Post,
  Req,
  Body,
  Query,
  Param,
  ParseUUIDPipe,
  UploadedFile,
  UseInterceptors,
  Res,
  StreamableFile,
  DefaultValuePipe,
  ParseIntPipe,
  BadRequestException,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { ColdCallsService } from "./cold-calls.service.js";
import { coldTemplate, type ColdFile } from "./cold-calls-file.js";
import {
  ColdQuery,
  ColdImport,
  ColdPreview,
  ColdConvert,
  ColdCallLog,
  ColdNote,
  ColdFollowUp,
  ColdAssignment,
} from "./cold-calls.dto.js";
@Controller("api/v1/cold-calls")
@RequireAccess(["company_admin", "company_user"], "leads.read")
export class ColdCallsController {
  constructor(private readonly s: ColdCallsService) {}
  @Get() list(@Req() r: AuthRequest, @Query() q: ColdQuery) {
    return this.s.list(r.principal, q);
  }
  @Get("options") options(@Req() r: AuthRequest) {
    return this.s.options(r.principal);
  }
  @Get(":id/history") history(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page: number,
  ) {
    if (page < 1 || page > 100000) throw new BadRequestException();
    return this.s.detail(r.principal, id, page);
  }
  @Post(":id/calls")
  @RequireAccess(["company_admin", "company_user"], "leads.manage")
  call(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: ColdCallLog,
  ) {
    return this.s.logCall(r.principal, id, b);
  }
  @Post(":id/notes")
  @RequireAccess(["company_admin", "company_user"], "leads.manage")
  note(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: ColdNote,
  ) {
    return this.s.note(r.principal, id, b);
  }
  @Post(":id/follow-up")
  @RequireAccess(["company_admin", "company_user"], "leads.manage")
  followUp(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: ColdFollowUp,
  ) {
    return this.s.followUp(r.principal, id, b);
  }
  @Post("assign")
  @RequireAccess(["company_admin", "company_user"], "leads.manage")
  assign(@Req() r: AuthRequest, @Body() b: ColdAssignment) {
    return this.s.assign(r.principal, b);
  }
  @ApiProduces(
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  )
  @ApiOkResponse({ schema: { type: "string", format: "binary" } })
  @Get("template")
  async template(
    @Req() r: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.s.previewAccess(r.principal);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="cold-calls-template.xlsx"',
    );
    res.setHeader("Cache-Control", "no-store");
    return new StreamableFile(await coldTemplate());
  }
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["file"],
      properties: { file: { type: "string", format: "binary" } },
    },
  })
  @Post("columns")
  @RequireAccess(["company_admin", "company_user"], "leads.manage")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0 },
    }),
  )
  columns(@Req() r: AuthRequest, @UploadedFile() f: ColdFile) {
    return this.s.columns(r.principal, f);
  }
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["file", "nameColumn", "phoneColumn"],
      properties: {
        file: { type: "string", format: "binary" },
        ownerId: { type: "string", format: "uuid" },
        nameColumn: { type: "integer", minimum: 1 },
        phoneColumn: { type: "integer", minimum: 1 },
      },
    },
  })
  @Post("preview")
  @RequireAccess(["company_admin", "company_user"], "leads.manage")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: {
        fileSize: 5 * 1024 * 1024,
        files: 1,
        fields: 3,
        fieldSize: 100,
      },
    }),
  )
  preview(
    @Req() r: AuthRequest,
    @UploadedFile() f: ColdFile,
    @Body() b: ColdPreview,
  ) {
    return this.s.preview(r.principal, f, b);
  }
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["file", "requestId", "nameColumn", "phoneColumn"],
      properties: {
        file: { type: "string", format: "binary" },
        ownerId: { type: "string", format: "uuid" },
        requestId: { type: "string", format: "uuid" },
        nameColumn: { type: "integer", minimum: 1 },
        phoneColumn: { type: "integer", minimum: 1 },
      },
    },
  })
  @Post("import")
  @RequireAccess(["company_admin", "company_user"], "leads.manage")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: {
        fileSize: 5 * 1024 * 1024,
        files: 1,
        fields: 4,
        fieldSize: 100,
      },
    }),
  )
  import(
    @Req() r: AuthRequest,
    @UploadedFile() f: ColdFile,
    @Body() b: ColdImport,
  ) {
    return this.s.import(r.principal, f, b);
  }
  @Post(":id/convert")
  @RequireAccess(["company_admin", "company_user"], "leads.manage")
  convert(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: ColdConvert,
  ) {
    return this.s.convert(r.principal, id, b);
  }
}
