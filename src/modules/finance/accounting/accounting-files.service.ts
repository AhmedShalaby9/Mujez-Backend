import { Injectable, BadRequestException } from "@nestjs/common";
import { z } from "zod";
import PDFDocument from "pdfkit";
import { fileURLToPath } from "node:url";
import type { Principal } from "../../../common/auth/access.js";
import { AccountingCore } from "./accounting.core.js";
import {
  inspectFile,
  type UploadFile,
} from "../documents/documents.service.js";
const kinds = [
  "journals",
  "transactions",
  "obligations",
  "custodies",
  "cheques",
  "deals",
  "reconciliations",
] as const;
@Injectable()
export class AccountingFilesService {
  constructor(readonly core: AccountingCore) {}
  kind(value: string) {
    if (!(kinds as readonly string[]).includes(value))
      throw new BadRequestException("Unknown financial document type");
    return value;
  }
  async list(p: Principal, kind: string, id: string) {
    this.kind(kind);
    return this.core.read(p, async (c) => {
      await this.core.row(c, p, kind, id);
      return {
        items: (
          await c.query(
            "SELECT id,name,mime,size,sha256,created_at FROM tenant.fin_attachments WHERE company_id=$1 AND entity_kind=$2 AND entity_id=$3 ORDER BY created_at DESC",
            [p.companyId, kind, id],
          )
        ).rows,
      };
    });
  }
  async upload(
    p: Principal,
    kind: string,
    id: string,
    input: unknown,
    file: UploadFile | undefined,
  ) {
    this.kind(kind);
    const b = this.core.parse(
        z.object({ requestId: z.uuid() }).strict(),
        input,
      ),
      f = inspectFile(file);
    return this.core.write(
      p,
      "finance.write",
      "file.upload" + kind + id,
      { ...b, sha256: f.sha256 },
      async (c) => {
        await this.core.row(c, p, kind, id);
        const r = (
          await c.query(
            "INSERT INTO tenant.fin_attachments(company_id,entity_kind,entity_id,name,mime,size,sha256,content,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
            [
              p.companyId,
              kind,
              id,
              f.name,
              f.mime,
              file!.buffer.length,
              f.sha256,
              file!.buffer,
              p.id,
            ],
          )
        ).rows[0];
        await this.core.event(c, p, id, "file.attached", { fileId: r.id });
        return r;
      },
    );
  }
  async download(p: Principal, id: string) {
    await this.core.access(p);
    return this.core.db.tenant(p.companyId!, async (c) => {
      const r = await this.core.row(c, p, "attachments", id);
      return { name: r.name, mime: r.mime, content: Buffer.from(r.content) };
    });
  }
  async print(p: Principal, kind: string, id: string) {
    if (!["journals", "transactions", "obligations"].includes(kind))
      throw new BadRequestException(
        "Choose a journal, voucher or financial document",
      );
    const data = await this.core.read(p, async (c) => {
      const r = await this.core.row(c, p, kind, id);
      const party = r.party_id
        ? await this.core.row(c, p, "parties", r.party_id)
        : null;
      const lines =
        kind === "journals"
          ? (
              await c.query(
                "SELECT a.code,a.name,l.debit_minor::text,l.credit_minor::text FROM tenant.fin_journal_lines l JOIN tenant.fin_accounts a ON a.company_id=l.company_id AND a.id=l.account_id WHERE l.company_id=$1 AND l.journal_id=$2",
                [p.companyId, id],
              )
            ).rows
          : [];
      return { r, party, lines };
    });
    const company = await this.core.db.platform(
      async (c) =>
        (
          await c.query("SELECT name FROM platform.companies WHERE id=$1", [
            p.companyId,
          ])
        ).rows[0],
    );
    return new Promise<{ name: string; content: Buffer }>((resolve, reject) => {
      const doc = new PDFDocument({ size: "A4", margin: 48 }),
        chunks: Buffer[] = [];
      doc.on("data", (x) => chunks.push(x));
      doc.on("error", reject);
      doc.on("end", () =>
        resolve({ name: data.r.code + ".pdf", content: Buffer.concat(chunks) }),
      );
      try {
        doc.registerFont(
          "Arabic",
          fileURLToPath(
            new URL(
              "../../../../assets/fonts/NotoSansArabic.ttf",
              import.meta.url,
            ),
          ),
        );
        const text = (s: string, size = 11) => {
          doc
            .font(/[\u0600-\u06ff]/.test(s) ? "Arabic" : "Helvetica")
            .fontSize(size)
            .text(s, {
              width: 499,
              align: /[\u0600-\u06ff]/.test(s) ? "right" : "left",
            })
            .moveDown(0.6);
        };
        const money = (v: any) => {
          const n = BigInt(v ?? "0");
          return (
            "EGP " +
            (n / 100n).toLocaleString("en-US") +
            "." +
            String(n % 100n < 0n ? -(n % 100n) : n % 100n).padStart(2, "0")
          );
        };
        text(company?.name?.en ?? "Company", 22);
        if (company?.name?.ar) text(company.name.ar, 16);
        text(
          kind === "transactions"
            ? "PAYMENT / RECEIPT VOUCHER"
            : kind === "journals"
              ? "JOURNAL ENTRY"
              : "FINANCIAL DOCUMENT",
          16,
        );
        text(data.r.code, 15);
        text("Date: " + String(data.r.entry_date).slice(0, 10));
        text("Status: " + (data.r.status ?? "recorded"));
        if (data.party) {
          text(data.party.name, 14);
          if (data.party.tax_number)
            text("Party tax registration: " + data.party.tax_number);
        }
        text(data.r.memo ?? data.r.description ?? "");
        if (kind === "obligations") {
          text("Net: " + money(data.r.net_minor));
          text(
            "Tax (" + data.r.tax_bps / 100 + "%): " + money(data.r.tax_minor),
          );
          text("Total: " + money(data.r.total_minor), 14);
          text("Due: " + data.r.due_date);
        }
        if (kind === "transactions") {
          text("Amount: " + money(data.r.amount_minor), 14);
          text("Method: " + data.r.method);
          text("Reference: " + data.r.reference);
        }
        for (const l of data.lines)
          text(
            l.code +
              " " +
              l.name +
              " | Debit " +
              money(l.debit_minor) +
              " | Credit " +
              money(l.credit_minor),
          );
        text(
          "Internal company record. Egyptian e-invoice submission is not configured.",
          9,
        );
        doc.end();
      } catch (e) {
        doc.destroy();
        reject(e);
      }
    });
  }
}
