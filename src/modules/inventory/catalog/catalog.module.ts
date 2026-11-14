import {
  Module,
  Controller,
  Get,
  Post,
  Req,
  Param,
  Query,
  Body,
  ParseUUIDPipe,
} from "@nestjs/common";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { CatalogService } from "./catalog.service.js";
@Controller("api/v1/catalog")
@RequireAccess(["platform", "company_admin", "company_user"])
export class CatalogController {
  constructor(private readonly s: CatalogService) {}
  @Get(":kind") list(
    @Req() r: AuthRequest,
    @Param("kind") k: string,
    @Query() q: Record<string, string>,
  ) {
    return this.s.list(r.principal, k, q);
  }
  @Get(":kind/:id") detail(
    @Req() r: AuthRequest,
    @Param("kind") k: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.s.detail(r.principal, k, id);
  }
  @Post(":kind") @RequireAccess(["platform"], "co.create") create(
    @Req() r: AuthRequest,
    @Param("kind") k: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.save(r.principal, k, b);
  }
  @Post(":kind/:id/update") @RequireAccess(["platform"], "co.create") update(
    @Req() r: AuthRequest,
    @Param("kind") k: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.save(r.principal, k, b, id);
  }
  @Post(":kind/:id/archive") @RequireAccess(["platform"], "co.create") archive(
    @Req() r: AuthRequest,
    @Param("kind") k: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.archive(r.principal, k, id, b);
  }
  @Post(":kind/:id/preference") preference(
    @Req() r: AuthRequest,
    @Param("kind") k: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.preference(r.principal, k, id, b);
  }
}
@Module({
  providers: [CatalogService],
  controllers: [CatalogController],
  exports: [CatalogService],
})
export class CatalogModule {}
