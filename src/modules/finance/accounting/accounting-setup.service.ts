import {
  Injectable,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import type { Principal } from "../../../common/auth/access.js";
import { AccountingCore, COA } from "./accounting.core.js";
import {
  setupInput,
  settingsInput,
  accountInput,
  dimensionInput,
  partyInput,
  periodInput,
  journalInput,
  actionInput,
  treasuryInput,
  queryInput,
} from "./accounting.schema.js";
@Injectable()
export class AccountingSetupService {
  constructor(readonly core: AccountingCore) {}
  async context(p: Principal) {
    return this.core.read(p, async (c) => ({
      configured: !!(
        await c.query("SELECT 1 FROM tenant.fin_settings WHERE company_id=$1", [
          p.companyId,
        ])
      ).rowCount,
      today: await this.core.today(c),
      canWrite: this.core.can(p, "finance.write"),
      canPost: this.core.can(p, "finance.post"),
      canApprove: this.core.can(p, "finance.approve"),
      canSettings: this.core.can(p, "finance.settings"),
      currency: "EGP",
      externalIntegrations: {
        egyptEInvoice: "not_configured",
        whatsapp: "not_configured",
      },
    }));
  }
  async setup(p: Principal, input: unknown) {
    const b = this.core.parse(setupInput, input);
    return this.core.write(p, "finance.settings", "setup", b, async (c) => {
      if (
        (
          await c.query(
            "SELECT 1 FROM tenant.fin_settings WHERE company_id=$1",
            [p.companyId],
          )
        ).rowCount
      )
        throw new ConflictException("Finance is already configured");
      await c.query(
        "INSERT INTO tenant.fin_settings(company_id,fiscal_month) VALUES($1,$2)",
        [p.companyId, b.fiscalMonth],
      );
      for (const [code, name, kind, key, cash] of COA)
        await c.query(
          "INSERT INTO tenant.fin_accounts(company_id,code,name,kind,system_key,is_cash) VALUES($1,$2,$3,$4,$5,$6)",
          [p.companyId, code, name, kind, key, cash],
        );
      const from = new Date(Date.UTC(b.year, b.fiscalMonth - 1, 1))
          .toISOString()
          .slice(0, 10),
        to = new Date(Date.UTC(b.year + 1, b.fiscalMonth - 1, 0))
          .toISOString()
          .slice(0, 10);
      await c.query(
        "INSERT INTO tenant.fin_periods(company_id,name,start_date,end_date) VALUES($1,$2,$3,$4)",
        [p.companyId, "FY " + b.year, from, to],
      );
      const cash = await this.core.system(c, p, "cash");
      await c.query(
        "INSERT INTO tenant.fin_treasuries(company_id,name,kind,account_id) VALUES($1,'Main cashbox / الخزينة الرئيسية','cash',$2)",
        [p.companyId, cash],
      );
      await this.core.event(c, p, p.companyId!, "setup.completed");
      return { configured: true };
    });
  }
  async options(p: Principal) {
    return this.core.read(p, async (c) => ({
      settings:
        (
          await c.query(
            "SELECT * FROM tenant.fin_settings WHERE company_id=$1",
            [p.companyId],
          )
        ).rows[0] ?? null,
      accounts: (
        await c.query(
          "SELECT * FROM tenant.fin_accounts WHERE company_id=$1 ORDER BY code",
          [p.companyId],
        )
      ).rows,
      dimensions: (
        await c.query(
          "SELECT * FROM tenant.fin_dimensions WHERE company_id=$1 ORDER BY kind,name",
          [p.companyId],
        )
      ).rows,
      parties: (
        await c.query(
          "SELECT * FROM tenant.fin_parties WHERE company_id=$1 ORDER BY name LIMIT 2000",
          [p.companyId],
        )
      ).rows,
      treasuries: (
        await c.query(
          "SELECT * FROM tenant.fin_treasuries WHERE company_id=$1 ORDER BY name",
          [p.companyId],
        )
      ).rows,
      employees: (
        await c.query(
          "SELECT e.id,e.user_id,e.name,e.employee_code FROM tenant.hr_employees e WHERE e.company_id=$1 AND e.status<>'offboarded' ORDER BY e.name LIMIT 2000",
          [p.companyId],
        )
      ).rows,
      users: (
        await c.query(
          "SELECT id,name FROM tenant.users WHERE company_id=$1 AND status='active' AND deleted_at IS NULL ORDER BY name LIMIT 2000",
          [p.companyId],
        )
      ).rows,
    }));
  }
  async settings(p: Principal, input: unknown) {
    const b = this.core.parse(settingsInput, input);
    return this.core.write(
      p,
      "finance.settings",
      "settings.save",
      b,
      async (c) => {
        await this.core.configured(c, p);
        const r = (
          await c.query(
            "SELECT * FROM tenant.fin_settings WHERE company_id=$1 FOR UPDATE",
            [p.companyId],
          )
        ).rows[0];
        this.core.version(r, b.version);
        await c.query(
          "UPDATE tenant.fin_settings SET fiscal_month=$2,vat_bps=$3,version=version+1 WHERE company_id=$1",
          [p.companyId, b.fiscalMonth, b.vatBps],
        );
        await this.core.event(c, p, p.companyId!, "settings.updated");
        return { saved: true };
      },
    );
  }
  async saveAccount(p: Principal, input: unknown, id?: string) {
    const b = this.core.parse(accountInput, input);
    return this.core.write(
      p,
      "finance.settings",
      "account.save" + (id ?? ""),
      b,
      async (c) => {
        await this.core.configured(c, p);
        let r: any;
        if (id) {
          r = await this.core.row(c, p, "accounts", id, true);
          this.core.version(r, b.version);
          if (
            r.system_key &&
            (b.kind !== r.kind || !b.active || b.code !== r.code)
          )
            throw new BadRequestException(
              "System account type/code and availability are fixed",
            );
          if (
            b.kind !== r.kind &&
            (
              await c.query(
                "SELECT 1 FROM tenant.fin_journal_lines WHERE company_id=$1 AND account_id=$2 LIMIT 1",
                [p.companyId, id],
              )
            ).rowCount
          )
            throw new BadRequestException(
              "A used account cannot change its type",
            );
          if (
            r.is_cash &&
            !b.active &&
            BigInt(await this.core.accountBalance(c, p, id)) !== 0n
          )
            throw new BadRequestException(
              "A treasury account with a balance cannot be disabled",
            );
          r = (
            await c.query(
              "UPDATE tenant.fin_accounts SET code=$3,name=$4,kind=$5,active=$6,cash_flow=$7,version=version+1 WHERE company_id=$1 AND id=$2 RETURNING id",
              [p.companyId, id, b.code, b.name, b.kind, b.active, b.cashFlow],
            )
          ).rows[0];
        } else
          r = (
            await c.query(
              "INSERT INTO tenant.fin_accounts(company_id,code,name,kind,cash_flow) VALUES($1,$2,$3,$4,$5) RETURNING id",
              [p.companyId, b.code, b.name, b.kind, b.cashFlow],
            )
          ).rows[0];
        await this.core.event(c, p, r.id, "account.saved");
        return r;
      },
    );
  }
  async saveDimension(p: Principal, input: unknown, id?: string) {
    const b = this.core.parse(dimensionInput, input);
    return this.core.write(
      p,
      "finance.settings",
      "dimension.save" + (id ?? ""),
      b,
      async (c) => {
        let r: any;
        if (id) {
          const old = await this.core.row(c, p, "dimensions", id, true);
          this.core.version(old, b.version);
          if (old.kind !== b.kind)
            throw new BadRequestException("Dimension type cannot change");
          r = (
            await c.query(
              "UPDATE tenant.fin_dimensions SET name=$3,active=$4,version=version+1 WHERE company_id=$1 AND id=$2 RETURNING id",
              [p.companyId, id, b.name, b.active],
            )
          ).rows[0];
        } else
          r = (
            await c.query(
              "INSERT INTO tenant.fin_dimensions(company_id,kind,name,active) VALUES($1,$2,$3,$4) RETURNING id",
              [p.companyId, b.kind, b.name, b.active],
            )
          ).rows[0];
        await this.core.event(c, p, r.id, "dimension.saved");
        return r;
      },
    );
  }
  async saveParty(p: Principal, input: unknown, id?: string) {
    const b = this.core.parse(partyInput, input);
    return this.core.write(
      p,
      "finance.write",
      "party.save" + (id ?? ""),
      b,
      async (c) => {
        if (b.referenceId) {
          if (b.kind === "employee") {
            if (
              !(
                await c.query(
                  "SELECT 1 FROM tenant.users WHERE company_id=$1 AND id=$2 AND deleted_at IS NULL",
                  [p.companyId, b.referenceId],
                )
              ).rowCount
            )
              throw new BadRequestException(
                "Choose an employee user from this company",
              );
          } else if (b.kind === "customer") {
            if (
              !(
                await c.query(
                  "SELECT 1 FROM tenant.leads WHERE company_id=$1 AND id=$2",
                  [p.companyId, b.referenceId],
                )
              ).rowCount
            )
              throw new BadRequestException(
                "Choose a customer lead from this company",
              );
          } else
            throw new BadRequestException(
              "Reference IDs are supported for employee users and customer leads",
            );
        }
        let r: any;
        if (id) {
          const old = await this.core.row(c, p, "parties", id, true);
          this.core.version(old, b.version);
          if (old.kind !== b.kind || old.reference_id !== b.referenceId)
            throw new BadRequestException(
              "Party type and linked identity cannot change",
            );
          r = (
            await c.query(
              "UPDATE tenant.fin_parties SET name=$3,email=$4,phone=$5,tax_number=$6,active=$7,version=version+1 WHERE company_id=$1 AND id=$2 RETURNING id",
              [
                p.companyId,
                id,
                b.name,
                b.email,
                b.phone,
                b.taxNumber,
                b.active,
              ],
            )
          ).rows[0];
        } else
          r = (
            await c.query(
              "INSERT INTO tenant.fin_parties(company_id,kind,name,email,phone,tax_number,reference_id,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
              [
                p.companyId,
                b.kind,
                b.name,
                b.email,
                b.phone,
                b.taxNumber,
                b.referenceId,
                b.active,
              ],
            )
          ).rows[0];
        await this.core.event(c, p, r.id, "party.saved");
        return r;
      },
    );
  }
  async periods(p: Principal) {
    return this.core.read(p, async (c) => ({
      items: (
        await c.query(
          "SELECT *,start_date::text,end_date::text FROM tenant.fin_periods WHERE company_id=$1 ORDER BY tenant.fin_periods.start_date DESC",
          [p.companyId],
        )
      ).rows,
    }));
  }
  async addPeriod(p: Principal, input: unknown) {
    const b = this.core.parse(periodInput, input);
    return this.core.write(
      p,
      "finance.settings",
      "period.create",
      b,
      async (c) => {
        if (
          (
            await c.query(
              "SELECT 1 FROM tenant.fin_periods WHERE company_id=$1 AND start_date<=$3::date AND end_date>=$2::date",
              [p.companyId, b.from, b.to],
            )
          ).rowCount
        )
          throw new ConflictException("Financial periods cannot overlap");
        const r = (
          await c.query(
            "INSERT INTO tenant.fin_periods(company_id,name,start_date,end_date) VALUES($1,$2,$3,$4) RETURNING id",
            [p.companyId, b.name, b.from, b.to],
          )
        ).rows[0];
        await this.core.event(c, p, r.id, "period.created");
        return r;
      },
    );
  }
  async periodAction(p: Principal, id: string, input: unknown) {
    const b = this.core.parse(actionInput, input);
    if (!["close", "reopen"].includes(b.action) || b.reason.length < 3)
      throw new BadRequestException("Choose close/reopen and provide a reason");
    return this.core.write(
      p,
      "finance.settings",
      "period." + b.action + id,
      b,
      async (c) => {
        const r = await this.core.row(c, p, "periods", id, true);
        this.core.version(r, b.version);
        if (r.closed === (b.action === "close"))
          throw new ConflictException("Period already has this status");
        if (
          b.action === "close" &&
          (
            await c.query(
              "SELECT 1 FROM tenant.fin_journals WHERE company_id=$1 AND status='draft' AND entry_date BETWEEN $2 AND $3 LIMIT 1",
              [p.companyId, r.start_date, r.end_date],
            )
          ).rowCount
        )
          throw new ConflictException(
            "Resolve draft journals before closing this period",
          );
        await c.query(
          "UPDATE tenant.fin_periods SET closed=$3,version=version+1 WHERE company_id=$1 AND id=$2",
          [p.companyId, id, b.action === "close"],
        );
        await this.core.event(c, p, id, "period." + b.action, {
          reason: b.reason,
        });
        return { id };
      },
    );
  }
  async journals(p: Principal, input: unknown) {
    const q = this.core.parse(queryInput, input);
    return this.core.read(p, async (c) => {
      const w =
        "j.company_id=$1 AND ($2='' OR j.status=$2) AND ($3::date IS NULL OR j.entry_date>=$3) AND ($4::date IS NULL OR j.entry_date<=$4) AND (j.code ILIKE $5 OR j.memo ILIKE $5)";
      const args = [
        p.companyId,
        q.status,
        q.from ?? null,
        q.to ?? null,
        "%" + q.q.replace(/[\\%_]/g, "\\$&") + "%",
      ];
      return {
        items: (
          await c.query(
            `SELECT j.*,j.entry_date::text,coalesce((SELECT sum(debit_minor) FROM tenant.fin_journal_lines WHERE company_id=j.company_id AND journal_id=j.id),0)::text AS total_minor,EXISTS(SELECT 1 FROM tenant.fin_journals r WHERE r.company_id=j.company_id AND r.reversal_of=j.id) AS reversed FROM tenant.fin_journals j WHERE ${w} ORDER BY j.entry_date DESC,j.code DESC LIMIT $6 OFFSET $7`,
            [...args, q.limit, (q.page - 1) * q.limit],
          )
        ).rows,
        total: Number(
          (
            await c.query(
              "SELECT count(*) FROM tenant.fin_journals j WHERE " + w,
              args,
            )
          ).rows[0].count,
        ),
        page: q.page,
        limit: q.limit,
      };
    });
  }
  async journal(p: Principal, id: string) {
    return this.core.read(p, async (c) => {
      const r = (
        await c.query(
          "SELECT *,entry_date::text FROM tenant.fin_journals WHERE company_id=$1 AND id=$2",
          [p.companyId, id],
        )
      ).rows[0];
      if (!r) await this.core.row(c, p, "journals", id);
      return {
        ...r,
        lines: (
          await c.query(
            "SELECT l.*,l.debit_minor::text,l.credit_minor::text,a.code AS account_code,a.name AS account_name,p.name AS party FROM tenant.fin_journal_lines l JOIN tenant.fin_accounts a ON a.company_id=l.company_id AND a.id=l.account_id LEFT JOIN tenant.fin_parties p ON p.company_id=l.company_id AND p.id=l.party_id WHERE l.company_id=$1 AND l.journal_id=$2 ORDER BY l.id",
            [p.companyId, id],
          )
        ).rows,
        reversals: (
          await c.query(
            "SELECT id,code,entry_date::text FROM tenant.fin_journals WHERE company_id=$1 AND reversal_of=$2",
            [p.companyId, id],
          )
        ).rows,
      };
    });
  }
  async saveJournal(p: Principal, input: unknown, id?: string) {
    const b = this.core.parse(journalInput, input);
    return this.core.write(
      p,
      "finance.write",
      "journal.save" + (id ?? ""),
      b,
      async (c) => {
        let journalId = id;
        if (id) {
          const r = await this.core.row(c, p, "journals", id, true);
          this.core.version(r, b.version);
          if (r.status !== "draft" || r.source_kind !== "manual")
            throw new ConflictException(
              "Only manual draft journals can be edited",
            );
          await this.core.validateLines(c, p, b.lines);
          await c.query(
            "DELETE FROM tenant.fin_journal_lines WHERE company_id=$1 AND journal_id=$2",
            [p.companyId, id],
          );
          await this.core.insertLines(c, p, id, b.lines);
          await c.query(
            "UPDATE tenant.fin_journals SET entry_date=$3,memo=$4,cash_flow=$5,version=version+1 WHERE company_id=$1 AND id=$2",
            [p.companyId, id, b.date, b.memo, b.cashFlow],
          );
        } else journalId = await this.core.makeJournal(c, p, b, false);
        await this.core.event(c, p, journalId!, "journal.saved");
        return { id: journalId };
      },
    );
  }
  async journalAction(p: Principal, id: string, input: unknown) {
    const b = this.core.parse(actionInput, input);
    if (!["post", "reverse"].includes(b.action))
      throw new BadRequestException("Choose post or reverse");
    return this.core.write(
      p,
      "finance.post",
      "journal." + b.action + id,
      b,
      async (c) => {
        const r = await this.core.row(c, p, "journals", id, true);
        this.core.version(r, b.version);
        if (r.source_kind !== "manual")
          throw new BadRequestException(
            "Use the source document to reverse an automatic journal",
          );
        if (b.action === "post") {
          await this.core.validateLines(
            c,
            p,
            (
              await c.query(
                'SELECT account_id AS "accountId",party_id AS "partyId",debit_minor::text AS "debitMinor",credit_minor::text AS "creditMinor" FROM tenant.fin_journal_lines WHERE company_id=$1 AND journal_id=$2',
                [p.companyId, id],
              )
            ).rows,
          );
          await this.core.post(c, p, id, b.version);
          return { id };
        }
        if (!b.date || b.reason.length < 3)
          throw new BadRequestException(
            "Reversal date and reason are required",
          );
        return { id: await this.core.reverse(c, p, id, b.date, b.reason) };
      },
    );
  }
  async treasuries(p: Principal) {
    return this.core.read(p, async (c) => ({
      items: await Promise.all(
        (
          await c.query(
            "SELECT t.*,a.code AS account_code FROM tenant.fin_treasuries t JOIN tenant.fin_accounts a ON a.company_id=t.company_id AND a.id=t.account_id WHERE t.company_id=$1 ORDER BY t.name",
            [p.companyId],
          )
        ).rows.map(async (t) => ({
          ...t,
          balanceMinor: await this.core.accountBalance(c, p, t.account_id),
        })),
      ),
    }));
  }
  async saveTreasury(p: Principal, input: unknown, id?: string) {
    const b = this.core.parse(treasuryInput, input);
    return this.core.write(
      p,
      "finance.settings",
      "treasury.save" + (id ?? ""),
      b,
      async (c) => {
        await this.core.configured(c, p);
        let r: any;
        if (id) {
          r = await this.core.row(c, p, "treasuries", id, true);
          this.core.version(r, b.version);
          if (r.kind !== b.kind)
            throw new BadRequestException("Treasury type cannot change");
          if (
            !b.active &&
            BigInt(await this.core.accountBalance(c, p, r.account_id)) !== 0n
          )
            throw new BadRequestException(
              "Clear the treasury balance before disabling it",
            );
          await c.query(
            "UPDATE tenant.fin_treasuries SET name=$3,bank_reference=$4,active=$5,version=version+1 WHERE company_id=$1 AND id=$2",
            [p.companyId, id, b.name, b.bankReference, b.active],
          );
        } else {
          const code = await this.core.next(c, p, "bank");
          const a = (
            await c.query(
              "INSERT INTO tenant.fin_accounts(company_id,code,name,kind,is_cash) VALUES($1,$2,$3,'asset',true) RETURNING id",
              [p.companyId, code, b.name],
            )
          ).rows[0];
          r = (
            await c.query(
              "INSERT INTO tenant.fin_treasuries(company_id,name,kind,account_id,bank_reference,active) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
              [p.companyId, b.name, b.kind, a.id, b.bankReference, b.active],
            )
          ).rows[0];
        }
        await this.core.event(c, p, r.id, "treasury.saved");
        return { id: r.id };
      },
    );
  }

  async history(p: Principal, kind: string, id: string) {
    const tables: Record<string, string> = {
      accounts: "accounts",
      dimensions: "dimensions",
      parties: "parties",
      periods: "periods",
      journals: "journals",
      treasuries: "treasuries",
      transactions: "transactions",
      obligations: "obligations",
      custodies: "custodies",
      cheques: "cheques",
      deals: "deals",
      reconciliations: "reconciliations",
      agreements: "agreements",
      "collection-targets": "collection_targets",
      "installment-plans": "installment_plans",
      "hr-advances": "source_links",
    };
    if (!tables[kind])
      throw new BadRequestException("Unknown finance history type");
    return this.core.read(p, async (c) => {
      if (kind === "hr-advances") {
        if (
          !(
            await c.query(
              "SELECT 1 FROM tenant.salary_advances WHERE company_id=$1 AND id=$2",
              [p.companyId, id],
            )
          ).rowCount
        )
          throw new BadRequestException("Choose a company advance");
      } else await this.core.row(c, p, tables[kind]!, id);
      return {
        items: (
          await c.query(
            "SELECT e.kind,e.details,e.created_at,u.name AS actor FROM tenant.fin_events e JOIN tenant.users u ON u.company_id=e.company_id AND u.id=e.actor_id WHERE e.company_id=$1 AND e.entity_id=$2 ORDER BY e.created_at DESC LIMIT 100",
            [p.companyId, id],
          )
        ).rows,
      };
    });
  }
}
