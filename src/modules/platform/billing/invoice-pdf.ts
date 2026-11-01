import PDFDocument from "pdfkit";
import { fileURLToPath } from "node:url";

const font = fileURLToPath(
  new URL("../../../../assets/fonts/NotoSansArabic.ttf", import.meta.url),
);
const money = (value: string, currency: string) => {
  const n = BigInt(value),
    sign = n < 0n ? "-" : "",
    absolute = n < 0n ? -n : n;
  return `${currency} ${sign}${(absolute / 100n).toLocaleString("en-US")}.${String(absolute % 100n).padStart(2, "0")}`;
};

/** Immutable invoice amounts/contact snapshot; never a gateway receipt or ETA document. */
export function renderInvoice(invoice: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 48,
      bufferPages: true,
      info: { Title: invoice.number, Author: "Mujez" },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    try {
      doc.registerFont("Arabic", font);
      const text = (value: string, size = 11, color = "#111113") => {
        const arabic = /[\u0600-\u06ff]/.test(value);
        doc
          .font(arabic ? "Arabic" : "Helvetica")
          .fontSize(size)
          .fillColor(color)
          .text(value, { width: 499, align: arabic ? "right" : "left" });
        doc.moveDown(0.6);
      };
      text("MUJEZ", 24);
      text("INVOICE", 18);
      text(invoice.number, 10, "#555555");
      text(`Status: ${invoice.status.toUpperCase()}`);
      text(`Issued: ${invoice.issueDate}   |   Due: ${invoice.dueDate}`);
      doc.moveDown();
      text("BILL TO", 10, "#555555");
      text(invoice.companyEn, 15);
      if (invoice.companyAr) text(invoice.companyAr);
      for (const line of [
        invoice.billingEmail,
        invoice.billingAddress,
        invoice.taxNumber ? "Tax registration: " + invoice.taxNumber : "",
        invoice.crNumber ? "Commercial registration: " + invoice.crNumber : "",
      ])
        if (line) text(line);
      doc.moveDown();
      text("DESCRIPTION", 10, "#555555");
      text(invoice.description);
      doc.moveDown();
      for (const [label, value] of [
        ["Subtotal", invoice.subtotalMinor],
        [`Tax (${invoice.taxBps / 100}%)`, invoice.taxMinor],
        ["Total", invoice.totalMinor],
        ["Payments (net of refunds)", invoice.paidMinor],
        ["Credit notes", invoice.creditedMinor],
        ["Balance due", invoice.balanceMinor],
      ]) {
        text(
          `${label}: ${money(value!, invoice.currency)}`,
          label === "Balance due" ? 15 : 11,
        );
      }
      doc.moveDown();
      text(
        invoice.status === "draft"
          ? "DRAFT - not issued. No payment has been collected by this document."
          : invoice.status === "void"
            ? "VOID - this invoice has been voided."
            : "Payment status reflects recorded payments and credit notes.",
        9,
        "#555555",
      );
      text(
        "This PDF is not an Egyptian Tax Authority e-invoice.",
        9,
        "#555555",
      );
      doc.end();
    } catch (e) {
      doc.destroy();
      reject(e);
    }
  });
}
