import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  Param,
  Query,
  ParseUUIDPipe,
} from "@nestjs/common";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { ActivityQuery } from "../leads/leads.dto.js";
import { ContactsService } from "./contacts.service.js";
import {
  ContactQuery,
  ContactInput,
  ContactUpdate,
  ContactArchive,
  ContactNote,
} from "./contacts.dto.js";
@RequireAccess(["company_admin"], "contacts.read")
@Controller("api/v1/contacts")
export class ContactsController {
  constructor(private readonly service: ContactsService) {}
  @Get() list(@Req() r: AuthRequest, @Query() q: ContactQuery) {
    return this.service.list(r.principal, q);
  }
  @Get("options") options(@Req() r: AuthRequest) {
    return this.service.options(r.principal);
  }
  @Get(":id") detail(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.service.detail(r.principal, id);
  }
  @Get(":id/activities") activities(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Query() q: ActivityQuery,
  ) {
    return this.service.activities(r.principal, id, q);
  }
  @Post() @RequireAccess(["company_admin"], "contacts.manage") create(
    @Req() r: AuthRequest,
    @Body() b: ContactInput,
  ) {
    return this.service.create(r.principal, b);
  }
  @Post(":id/update")
  @RequireAccess(["company_admin"], "contacts.manage")
  update(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: ContactUpdate,
  ) {
    return this.service.update(r.principal, id, b);
  }
  @Post(":id/archive")
  @RequireAccess(["company_admin"], "contacts.manage")
  archive(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: ContactArchive,
  ) {
    return this.service.archive(r.principal, id, b);
  }
  @Post(":id/notes") @RequireAccess(["company_admin"], "contacts.manage") note(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: ContactNote,
  ) {
    return this.service.note(r.principal, id, b);
  }
}
