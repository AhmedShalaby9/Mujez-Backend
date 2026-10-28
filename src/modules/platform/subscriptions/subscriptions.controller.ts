import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  Param,
  Query,
  DefaultValuePipe,
  ParseIntPipe,
  BadRequestException,
} from "@nestjs/common";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { SubscriptionsService } from "./subscriptions.service.js";
import {
  PlanCreate,
  PlanEdit,
  PlanArchive,
  Revision,
  SubscriptionCreate,
  SubscriptionChange,
} from "./subscriptions.dto.js";
@Controller("admin/api/v1")
export class SubscriptionsController {
  constructor(private readonly service: SubscriptionsService) {}
  @RequireAccess(["platform"], "sub.manage") @Get("plan-options") options() {
    return this.service.plans();
  }
  @RequireAccess(["platform"], "plans") @Get("plans") plans() {
    return this.service.plans();
  }
  @RequireAccess(["platform"], "plans") @Post("plans") createPlan(
    @Body() body: PlanCreate,
    @Req() req: AuthRequest,
  ) {
    return this.service.createPlan(body, req.principal.id);
  }
  @RequireAccess(["platform"], "plans") @Post("plans/:key/update") editPlan(
    @Param("key") key: string,
    @Body() body: PlanEdit,
    @Req() req: AuthRequest,
  ) {
    return this.service.editPlan(key, body, req.principal.id);
  }
  @RequireAccess(["platform"], "plans") @Post("plans/:key/archive") archive(
    @Param("key") key: string,
    @Body() body: PlanArchive,
    @Req() req: AuthRequest,
  ) {
    return this.service.archivePlan(
      key,
      body.version,
      body.archived,
      req.principal.id,
    );
  }
  @RequireAccess(["platform"], "sub.manage") @Get("subscriptions") list(
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query("limit", new DefaultValuePipe(100), ParseIntPipe) limit: number,
  ) {
    if (page < 1 || page > 100000 || limit < 1 || limit > 100)
      throw new BadRequestException();
    return this.service.list(page, limit);
  }
  @RequireAccess(["platform"], "sub.manage") @Post("subscriptions") create(
    @Body() body: SubscriptionCreate,
    @Req() req: AuthRequest,
  ) {
    return this.service.create(body, req.principal.id);
  }
  @RequireAccess(["platform"], "sub.manage")
  @Post("subscriptions/:id/change")
  change(
    @Param("id") id: string,
    @Body() body: SubscriptionChange,
    @Req() req: AuthRequest,
  ) {
    return this.service.action(
      id,
      body.version,
      "change",
      req.principal.id,
      body,
    );
  }
  @RequireAccess(["platform"], "sub.manage")
  @Post("subscriptions/:id/cancel")
  cancel(
    @Param("id") id: string,
    @Body() body: Revision,
    @Req() req: AuthRequest,
  ) {
    return this.service.action(id, body.version, "cancel", req.principal.id);
  }
  @RequireAccess(["platform"], "sub.manage")
  @Post("subscriptions/:id/renew")
  renew(
    @Param("id") id: string,
    @Body() body: Revision,
    @Req() req: AuthRequest,
  ) {
    return this.service.action(id, body.version, "renew", req.principal.id);
  }
}
