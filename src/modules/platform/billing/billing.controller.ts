import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Req,
  Query,
  DefaultValuePipe,
  ParseIntPipe,
  BadRequestException,
} from "@nestjs/common";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { BillingService } from "./billing.service.js";
import {
  InvoiceInput,
  InvoiceVersion,
  PaymentInput,
  SensitiveInput,
  AdjustmentInput,
  ReconcileInput,
} from "./billing.dto.js";
@RequireAccess(["platform"], "billing")
@Controller("admin/api/v1")
export class BillingController {
  constructor(private readonly service: BillingService) {}
  @Get("invoices") invoices(
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query("limit", new DefaultValuePipe(100), ParseIntPipe) limit: number,
  ) {
    this.page(page, limit);
    return this.service.invoices(page, limit);
  }
  @Get("payments") payments(
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query("limit", new DefaultValuePipe(100), ParseIntPipe) limit: number,
  ) {
    this.page(page, limit);
    return this.service.payments(page, limit);
  }
  private page(page: number, limit: number) {
    if (page < 1 || page > 100000 || limit < 1 || limit > 100)
      throw new BadRequestException();
  }
  @Get("invoices/:number") invoiceDetails(@Param("number") number: string) {
    return this.service.invoiceDetails(number);
  }
  @Get("payments/:id") paymentDetails(@Param("id") id: string) {
    return this.service.paymentDetails(id);
  }
  @Post("invoices") create(
    @Body() body: InvoiceInput,
    @Req() req: AuthRequest,
  ) {
    return this.service.create(body, req.principal.id);
  }
  @Post("invoices/:number/issue") issue(
    @Param("number") number: string,
    @Body() body: InvoiceVersion,
    @Req() req: AuthRequest,
  ) {
    return this.service.issue(number, body, req.principal.id);
  }
  @Post("invoices/:number/payments") record(
    @Param("number") number: string,
    @Body() body: PaymentInput,
    @Req() req: AuthRequest,
  ) {
    return this.service.record(number, body, req.principal.id);
  }
  @Post("invoices/:number/void") void(
    @Param("number") number: string,
    @Body() body: SensitiveInput,
    @Req() req: AuthRequest,
  ) {
    return this.service.void(number, body, req.principal.id);
  }
  @Post("invoices/:number/credits") credit(
    @Param("number") number: string,
    @Body() body: AdjustmentInput,
    @Req() req: AuthRequest,
  ) {
    return this.service.credit(number, body, req.principal.id);
  }
  @Post("payments/:id/refunds") refund(
    @Param("id") id: string,
    @Body() body: AdjustmentInput,
    @Req() req: AuthRequest,
  ) {
    return this.service.refund(id, body, req.principal.id);
  }
  @Post("payments/:id/reconcile") reconcile(
    @Param("id") id: string,
    @Body() body: ReconcileInput,
    @Req() req: AuthRequest,
  ) {
    return this.service.reconcile(id, body, req.principal.id);
  }
}
