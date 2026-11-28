import ExcelJS from "exceljs";

export type EmployeeExportRow = {
  code: string;
  name: string;
  position: string;
  roles: string;
  department: string;
  status: string;
  baseMinor: string | null;
  allowanceMinor: string | null;
  deductionMinor: string | null;
};
const HEADERS = {
  en: [
    "Employee code",
    "Name",
    "Position",
    "System roles",
    "Department",
    "Status",
    "Base salary (EGP)",
    "Allowances (EGP)",
    "Deductions (EGP)",
  ],
  ar: [
    "كود الموظف",
    "الاسم",
    "المسمى الوظيفي",
    "أدوار النظام",
    "القسم",
    "الحالة",
    "الراتب الأساسي (جنيه)",
    "البدلات (جنيه)",
    "الخصومات (جنيه)",
  ],
};
const STATUS: Record<string, [string, string]> = {
  onboarding: ["Onboarding", "قيد التعيين"],
  active: ["Active", "نشط"],
  on_leave: ["On leave", "في إجازة"],
  offboarded: ["Offboarded", "منتهي العمل"],
};
/** Exact decimal text for an integer amount in minor units. */
const money = (v: string | null) => {
  if (v === null) return "";
  const n = v.padStart(3, "0");
  return n.slice(0, -2) + "." + n.slice(-2);
};
/** Stop spreadsheet apps from running a typed-in value as a formula. */
const safe = (v: string) => (/^[=+\-@\t\r]/.test(v) ? "'" + v : v);

export async function employeeSheet(
  rows: EmployeeExportRow[],
  format: "csv" | "xlsx",
  lang: "en" | "ar",
) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet(lang === "ar" ? "الموظفون" : "Employees", {
    views: [{ rightToLeft: lang === "ar", state: "frozen", ySplit: 1 }],
  });
  sheet.addRow(HEADERS[lang]);
  for (const r of rows) {
    const salary = [r.baseMinor, r.allowanceMinor, r.deductionMinor];
    sheet.addRow([
      ...[
        r.code,
        r.name,
        r.position,
        r.roles,
        r.department,
        STATUS[r.status]?.[lang === "ar" ? 1 : 0] ?? r.status,
      ].map(safe),
      // Numbers in Excel so they can be summed; exact text in CSV.
      ...salary.map((v) =>
        format === "xlsx" ? (v === null ? null : Number(v) / 100) : money(v),
      ),
    ]);
  }
  if (format === "csv") {
    // The byte-order mark makes Excel read Arabic text as UTF-8.
    const body = Buffer.from(await book.csv.writeBuffer());
    return Buffer.concat([Buffer.from("﻿", "utf8"), body]);
  }
  sheet.getRow(1).font = { bold: true };
  sheet.columns.forEach((column, i) => {
    column.width = i < 6 ? 24 : 20;
    if (i >= 6) column.numFmt = "#,##0.00";
  });
  return Buffer.from(await book.xlsx.writeBuffer());
}
