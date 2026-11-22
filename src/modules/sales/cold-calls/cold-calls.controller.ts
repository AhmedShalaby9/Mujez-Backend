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
} from "./cold-calls.dto.js";
@Controller("api/v1/cold-calls")
@RequireAccess(["company_admin", "company_user"], "leads.read")
export class ColdCallsController {
  constructor(private readonly s: ColdCallsService) {}
  @Get() list(@Req() r: AuthRequest, @Query() q: ColdQuery) {
    return this.s.list(r.principal, q);
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
      properties: {
        file: { type: "string", format: "binary" },
        ownerId: { type: "string", format: "uuid" },
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
        fields: 2,
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
      required: ["file", "requestId"],
      properties: {
        file: { type: "string", format: "binary" },
        ownerId: { type: "string", format: "uuid" },
        requestId: { type: "string", format: "uuid" },
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
        fields: 3,
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
