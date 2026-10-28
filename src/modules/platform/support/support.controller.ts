import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Req,
  Query,
  DefaultValuePipe,
  ParseIntPipe,
  ParseUUIDPipe,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { SupportService } from "./support.service.js";
import {
  TicketInput,
  TicketChange,
  EntryInput,
  WorkspaceInput,
  Version,
} from "./support.dto.js";
@RequireAccess(["platform"], "support")
@Controller("admin/api/v1/support-tickets")
export class SupportController {
  constructor(private readonly service: SupportService) {}
  @Get() list(
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query("limit", new DefaultValuePipe(100), ParseIntPipe) limit: number,
  ) {
    if (page < 1 || page > 100000 || limit < 1 || limit > 100)
      throw new BadRequestException();
    return this.service.list(page, limit);
  }
  @Get("options") options() {
    return this.service.options();
  }
  @Get("summary") summary() {
    return this.service.summary();
  }
  @Get(":id") detail(@Param("id") id: string) {
    return this.service.detail(id);
  }
  @Post() create(@Body() input: TicketInput, @Req() req: AuthRequest) {
    return this.service.create(input, req.principal.id);
  }
  @Post(":id/update") change(
    @Param("id") id: string,
    @Body() input: TicketChange,
    @Req() req: AuthRequest,
  ) {
    return this.service.change(id, input, req.principal.id);
  }
  @Post(":id/entries") entry(
    @Param("id") id: string,
    @Body() input: EntryInput,
    @Req() req: AuthRequest,
  ) {
    return this.service.entry(id, input, req.principal.id);
  }
  @Post(":id/workspace-requests") request(
    @Param("id") id: string,
    @Body() input: WorkspaceInput,
    @Req() req: AuthRequest,
  ) {
    if (!req.principal.permissions.includes("ws.read"))
      throw new ForbiddenException();
    return this.service.requestWorkspace(id, input, req.principal.id);
  }
  @Post(":id/workspace-requests/:requestId/cancel") cancel(
    @Param("id") id: string,
    @Param("requestId", ParseUUIDPipe) requestId: string,
    @Body() input: Version,
    @Req() req: AuthRequest,
  ) {
    return this.service.cancelWorkspace(id, requestId, input, req.principal.id);
  }
}
