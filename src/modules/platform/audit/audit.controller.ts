import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  Req,
  ParseUUIDPipe,
} from "@nestjs/common";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { AuditService } from "./audit.service.js";
import { AuditQuery, AuditExport } from "./audit.dto.js";
@RequireAccess(["platform"], "audit")
@Controller("admin/api/v1/audit-logs")
export class PlatformAuditController {
  constructor(private readonly service: AuditService) {}
  @Get() list(@Query() input: AuditQuery) {
    return this.service.list(input);
  }
  @Get(":id") detail(@Param("id", ParseUUIDPipe) id: string) {
    return this.service.detail(id);
  }
  @Post("export") export(@Body() input: AuditExport, @Req() req: AuthRequest) {
    return this.service.export(input, req.principal.id);
  }
}
