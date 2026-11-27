import type { PoolClient } from "pg";
import type { Principal } from "../../../common/auth/access.js";
import type { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { AccountingCore } from "../../finance/accounting/accounting.core.js";
import { AccountingObligationsService } from "../../finance/accounting/accounting-obligations.service.js";
import { quoteCommission } from "../../finance/accounting/accounting.schema.js";

/** A separate platform-schema connection, so callers must fetch this before
 * opening (and never from inside) a tenant transaction -- nesting the two
 * deadlocks against this harness's/driver's single serialized connection. */
export async function companyFinanceEnabled(
  db: DatabaseService,
  companyId: string,
) {
  return !!(
    await db.platform(
      async (pc) =>
        (
          await pc.query(
            "SELECT finance_enabled FROM platform.companies WHERE id=$1",
            [companyId],
          )
        ).rows[0],
    )
  )?.finance_enabled;
}

/**
 * Best-effort: when a brokerage deal is approved as a signed contract and
 * the company has Finance, post the developer's claim automatically from
 * their agreement (if one is set up). Sales commissions are not computed
 * here -- the Sales Admin enters those by hand once the deal is approved.
 * Never throws: a missing agreement, unconfigured Finance, or anything else
 * just means no claim is posted yet, and the deal approval itself is
 * unaffected either way.
 */
export async function bookDeveloperClaim(
  db: DatabaseService,
  c: PoolClient,
  p: Principal,
  deal: {
    id: string;
    developerId: string;
    unitValueMinor: string;
    developerClaimObligationId: string | null;
  },
  financeEnabled: boolean,
) {
  try {
    if (deal.developerClaimObligationId) return null;
    if (!financeEnabled) return null;
    if (
      !(
        await c.query("SELECT 1 FROM tenant.fin_settings WHERE company_id=$1", [
          p.companyId,
        ])
      ).rowCount
    )
      return null;
    const developer = (
      await c.query(
        "SELECT name FROM tenant.brokerage_developers WHERE company_id=$1 AND id=$2",
        [p.companyId, deal.developerId],
      )
    ).rows[0];
    if (!developer) return null;
    let party = (
      await c.query(
        "SELECT id FROM tenant.fin_parties WHERE company_id=$1 AND kind='developer' AND reference_id=$2",
        [p.companyId, deal.developerId],
      )
    ).rows[0];
    if (!party)
      party = (
        await c.query(
          "INSERT INTO tenant.fin_parties(company_id,kind,name,reference_id) VALUES($1,'developer',$2,$3) RETURNING id",
          [p.companyId, developer.name, deal.developerId],
        )
      ).rows[0];
    const agreement = (
      await c.query(
        "SELECT * FROM tenant.fin_agreements WHERE company_id=$1 AND developer_id=$2 AND active LIMIT 1",
        [p.companyId, party.id],
      )
    ).rows[0];
    if (!agreement) return null;
    const gross = quoteCommission(deal.unitValueMinor, agreement);
    if (BigInt(gross) <= 0n) return null;
    const dates = (
      await c.query(
        `SELECT (now() AT TIME ZONE 'Africa/Cairo')::date::text AS today,
                ((now() AT TIME ZONE 'Africa/Cairo')::date + $1 * interval '1 day')::date::text AS due`,
        [agreement.due_days],
      )
    ).rows[0];
    const vat =
      (
        await c.query(
          "SELECT vat_bps FROM tenant.fin_settings WHERE company_id=$1",
          [p.companyId],
        )
      ).rows[0]?.vat_bps ?? 0;
    const core = new AccountingCore(db);
    const obligations = new AccountingObligationsService(core);
    const row = await obligations.insert(
      c,
      p,
      {
        kind: "developer_claim",
        partyId: party.id,
        netMinor: gross,
        taxBps: vat,
        date: dates.today,
        dueDate: dates.due,
        description: "Brokerage deal commission claim",
      },
      "approved",
    );
    await obligations.posting(c, p, row);
    await c.query(
      "UPDATE tenant.brokerage_deals SET developer_claim_obligation_id=$2 WHERE company_id=$1 AND id=$3",
      [p.companyId, row.id, deal.id],
    );
    return row;
  } catch {
    return null;
  }
}
