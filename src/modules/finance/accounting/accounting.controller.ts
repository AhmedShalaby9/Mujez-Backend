import { AccountingPoliciesService } from "./accounting-policies.service.js";
import { AccountingPayrollService } from "./accounting-payroll.service.js";
import { AccountingAutomationService } from "./accounting-automation.service.js";
import { AccountingPerformanceService } from "./accounting-performance.service.js";
import { AccountingInstallmentsService } from "./accounting-installments.service.js";
import { AccountingReportsService } from "./accounting-reports.service.js";
import { AccountingDealsService } from "./accounting-deals.service.js";
import { AccountingEmployeesService } from "./accounting-employees.service.js";
import {
  Controller,
  Get,
  Post,
  Req,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
} from "@nestjs/common";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { AccountingSetupService } from "./accounting-setup.service.js";
import { AccountingTreasuryService } from "./accounting-treasury.service.js";
import { AccountingObligationsService } from "./accounting-obligations.service.js";
@Controller("api/v1/accounting")
@RequireAccess(["company_admin", "company_user"])
export class AccountingController {
  constructor(
    readonly policies: AccountingPoliciesService,
    readonly payroll: AccountingPayrollService,
    readonly automation: AccountingAutomationService,
    private readonly performance: AccountingPerformanceService,
    private readonly installments: AccountingInstallmentsService,
    private readonly reports: AccountingReportsService,
    private readonly deals: AccountingDealsService,
    private readonly employees: AccountingEmployeesService,
    private readonly s: AccountingSetupService,
    private readonly t: AccountingTreasuryService,
    private readonly o: AccountingObligationsService,
  ) {}
  @Get("context") context(@Req() r: AuthRequest) {
    return this.s.context(r.principal);
  }
  @Post("setup") setup(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.setup(r.principal, b);
  }
  @Get("options") options(@Req() r: AuthRequest) {
    return this.s.options(r.principal);
  }
  @Post("settings") settings(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.settings(r.principal, b);
  }
  @Post("accounts") account(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.saveAccount(r.principal, b);
  }
  @Post("accounts/:id") editAccount(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.saveAccount(r.principal, b, id);
  }
  @Post("dimensions") dimension(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.saveDimension(r.principal, b);
  }
  @Post("dimensions/:id") editDimension(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.saveDimension(r.principal, b, id);
  }
  @Post("parties") party(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.saveParty(r.principal, b);
  }
  @Post("parties/:id") editParty(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.saveParty(r.principal, b, id);
  }
  @Get("periods") periods(@Req() r: AuthRequest) {
    return this.s.periods(r.principal);
  }
  @Post("periods") period(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.addPeriod(r.principal, b);
  }
  @Post("periods/:id/action") periodAction(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.periodAction(r.principal, id, b);
  }
  @Get("journals") journals(
    @Req() r: AuthRequest,
    @Query() q: Record<string, string>,
  ) {
    return this.s.journals(r.principal, q);
  }
  @Get("journals/:id") journal(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.s.journal(r.principal, id);
  }
  @Post("journals") saveJournal(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.saveJournal(r.principal, b);
  }
  @Post("journals/:id") editJournal(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.saveJournal(r.principal, b, id);
  }
  @Post("journals/:id/action") journalAction(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.journalAction(r.principal, id, b);
  }
  @Get("treasuries") treasuries(@Req() r: AuthRequest) {
    return this.s.treasuries(r.principal);
  }
  @Post("treasuries") treasury(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.saveTreasury(r.principal, b);
  }
  @Post("treasuries/:id") editTreasury(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.saveTreasury(r.principal, b, id);
  }
  @Get("transactions") transactions(
    @Req() r: AuthRequest,
    @Query() q: Record<string, string>,
  ) {
    return this.t.list(r.principal, q);
  }
  @Post("transactions") transaction(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.t.create(r.principal, b);
  }
  @Post("transactions/:id/action") reverseTransaction(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.t.reverse(r.principal, id, b);
  }
  @Get("obligations") obligations(
    @Req() r: AuthRequest,
    @Query() q: Record<string, string>,
  ) {
    return this.o.list(r.principal, q);
  }
  @Get("obligations/:id") obligation(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.o.detail(r.principal, id);
  }
  @Post("obligations") createObligation(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.o.create(r.principal, b);
  }
  @Post("obligations/:id/action") obligationAction(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.o.action(r.principal, id, b);
  }
  @Get("cheques") cheques(
    @Req() r: AuthRequest,
    @Query() q: Record<string, string>,
  ) {
    return this.t.cheques(r.principal, q);
  }
  @Post("cheques") cheque(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.t.createCheque(r.principal, b);
  }
  @Post("cheques/:id/action") chequeAction(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.t.chequeAction(r.principal, id, b);
  }
  @Get("reconciliations") reconciliations(@Req() r: AuthRequest) {
    return this.t.reconciliations(r.principal);
  }
  @Get("reconciliation-lines") reconciliationLines(
    @Req() r: AuthRequest,
    @Query("treasuryId", ParseUUIDPipe) id: string,
    @Query("to") to: string,
  ) {
    return this.t.reconciliationLines(r.principal, id, to);
  }
  @Post("reconciliations") reconcile(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.t.reconcile(r.principal, b);
  }

  @Get("overview") overview(
    @Req() r: AuthRequest,
    @Query() q: Record<string, string>,
  ) {
    return this.reports.overview(r.principal, q);
  }
  @Get("reports") report(
    @Req() r: AuthRequest,
    @Query() q: Record<string, string>,
  ) {
    return [
      "sales_performance",
      "expenses_by_centre",
      "collections",
      "tax",
    ].includes(q.kind ?? "")
      ? this.performance.report(r.principal, q)
      : this.reports.report(r.principal, q);
  }
  @Get("reminders") reminders(@Req() r: AuthRequest) {
    return this.reports.reminders(r.principal);
  }
  @Get("self") self(@Req() r: AuthRequest, @Query() q: Record<string, string>) {
    return this.reports.self(r.principal, q);
  }
  @Get("agreements") agreements(@Req() r: AuthRequest) {
    return this.deals.agreements(r.principal);
  }
  @Post("agreements") createAgreement(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.deals.agreement(r.principal, b);
  }
  @Post("agreements/:id") editAgreement(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.deals.agreement(r.principal, b, id);
  }
  @Get("deals") dealsList(
    @Req() r: AuthRequest,
    @Query() q: Record<string, string>,
  ) {
    return this.deals.deals(r.principal, q);
  }
  @Post("deals/:id/book") bookDeal(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.deals.book(r.principal, id, b);
  }
  @Post("deals/:id/action") adjustDeal(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.deals.adjust(r.principal, id, b);
  }
  @Get("custodies") custodies(
    @Req() r: AuthRequest,
    @Query() q: Record<string, string>,
  ) {
    return this.employees.custodies(r.principal, q);
  }
  @Post("custodies") custody(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.employees.custodyCreate(r.principal, b);
  }
  @Post("custodies/:id/action") custodyAction(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.employees.custodyAction(r.principal, id, b);
  }
  @Get("hr-advances") hrAdvances(@Req() r: AuthRequest) {
    return this.employees.advances(r.principal);
  }
  @Post("hr-advances/:id/action") advanceAction(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.employees.advanceAction(r.principal, id, b);
  }
  @Post("obligations/:id/settle-advance") settleAdvance(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.employees.offset(r.principal, id, b);
  }
  @Post("reconciliations/:id/action") reconciliationAction(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.t.reconciliationAction(r.principal, id, b);
  }
  @Get("installment-plans") installmentPlans(
    @Req() r: AuthRequest,
    @Query() q: Record<string, string>,
  ) {
    return this.installments.list(r.principal, q);
  }
  @Post("installment-plans") createPlan(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.installments.create(r.principal, b);
  }
  @Post("installment-plans/:id/action") planAction(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.installments.action(r.principal, id, b);
  }
  @Get("collection-targets") targets(@Req() r: AuthRequest) {
    return this.performance.targets(r.principal);
  }
  @Post("collection-targets") target(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.performance.target(r.principal, b);
  }
  @Post("collection-targets/:id") editTarget(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.performance.target(r.principal, b, id);
  }
  @Get("history/:kind/:id") history(
    @Req() r: AuthRequest,
    @Param("kind") kind: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.s.history(r.principal, kind, id);
  }
  @Get("commission-policies") commissionPolicies(@Req() r: AuthRequest) {
    return this.policies.list(r.principal);
  }
  @Post("commission-policies") createPolicy(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.policies.save(r.principal, b);
  }
  @Post("commission-policies/:id") editPolicy(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.policies.save(r.principal, b, id);
  }
  @Get("automation-rules") rules(@Req() r: AuthRequest) {
    return this.automation.list(r.principal);
  }
  @Post("automation-rules") createRule(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.automation.save(r.principal, b);
  }
  @Post("automation-rules/:id") editRule(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.automation.save(r.principal, b, id);
  }
  @Post("automation-process") processRules(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.automation.run(r.principal, b);
  }
  @Get("payroll-context") payrollContext(@Req() r: AuthRequest) {
    return this.payroll.context(r.principal);
  }
  @Get("payroll-options") payrollOptions(@Req() r: AuthRequest) {
    return this.payroll.options(r.principal);
  }
  @Get("salary-profiles") salaryProfiles(@Req() r: AuthRequest) {
    return this.payroll.profiles(r.principal);
  }
  @Post("salary-profiles") salaryProfile(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.payroll.profile(r.principal, b);
  }
  @Post("salary-profiles/:id") editSalaryProfile(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.payroll.profile(r.principal, b, id);
  }
  @Get("payroll-runs") payrollRuns(@Req() r: AuthRequest) {
    return this.payroll.list(r.principal);
  }
  @Post("payroll-runs") preparePayroll(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.payroll.prepare(r.principal, b);
  }
  @Get("payroll-runs/:id") payrollRun(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.payroll.detail(r.principal, id);
  }
  @Post("payroll-runs/:id/action") payrollAction(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.payroll.action(r.principal, id, b);
  }

  @Get("staff-statements") staffStatements(
    @Req() r: AuthRequest,
    @Query() q: Record<string, string>,
  ) {
    return this.reports.staff(r.principal, q);
  }
}
