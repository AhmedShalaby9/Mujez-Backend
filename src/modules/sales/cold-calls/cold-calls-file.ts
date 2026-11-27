import { BadRequestException } from "@nestjs/common";
import ExcelJS from "exceljs";
import { unzipSync } from "fflate";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { normalizePhone } from "../leads/sales.service.js";
export type ColdFile = { buffer: Buffer; originalname: string; size: number };
export type ColdRow = { row: number; name: string; phone: string };
export type ColdColumnMapping = { nameColumn: number; phoneColumn: number };
export const MAX_ROWS = 2000;
async function readColdSheet(file: ColdFile | undefined) {
  if (!file?.buffer?.length || file.buffer.length > 5 * 1024 * 1024)
    throw new BadRequestException(
      "Upload an XLSX or UTF-8 CSV file up to 5 MB",
    );
  const ext = file.originalname.toLowerCase().split(".").pop();
  if (!["xlsx", "csv"].includes(ext ?? ""))
    throw new BadRequestException(
      "Supported formats: .xlsx and .csv. Save legacy .xls as .xlsx first.",
    );
  const workbook = new ExcelJS.Workbook();
  let sheet: ExcelJS.Worksheet;
  try {
    if (ext === "xlsx") {
      let bytes = 0,
        entries = 0;
      const files = unzipSync(file.buffer, {
        filter: (f) => {
          bytes += f.originalSize;
          entries++;
          if (bytes > 8 * 1024 * 1024 || entries > 2000)
            throw Error("Workbook too large");
          return true;
        },
      });
      for (const [path, bytes] of Object.entries(files)) {
        if (/^xl\/worksheets\/[^/]+\.xml$/.test(path)) {
          const xml = new TextDecoder().decode(bytes);
          if (
            (xml.match(/<(?:\w+:)?row\b/g) ?? []).length > MAX_ROWS + 1 ||
            (xml.match(/<(?:\w+:)?c\b/g) ?? []).length > (MAX_ROWS + 1) * 2
          )
            throw Error("Too many cells");
          for (const match of xml.matchAll(
            /<(?:\w+:)?row\b[^>]*\br=["'](\d+)["']/g,
          ))
            if (Number(match[1]) > MAX_ROWS + 1)
              throw Error("Row index too large");
        }
      }
      await workbook.xlsx.load(file.buffer as any);
      if (workbook.worksheets.length !== 1)
        throw Error("Use exactly one worksheet");
      sheet = workbook.worksheets[0]!;
    } else {
      const raw = new TextDecoder("utf-8", { fatal: true })
        .decode(file.buffer)
        .replace(/^﻿/, "");
      const first = raw.split(/\r?\n/, 1)[0] ?? "";
      sheet = await workbook.csv.read(Readable.from([raw]), {
        map: (v: string) => v,
        parserOptions: {
          delimiter: first.includes(";") ? ";" : ",",
          maxRows: MAX_ROWS + 2,
        },
      });
    }
  } catch {
    throw new BadRequestException(
      "Cannot read file. Use one worksheet, a header row, UTF-8 CSV or a valid XLSX (maximum 2,000 rows).",
    );
  }
  if (sheet.rowCount > MAX_ROWS + 1)
    throw new BadRequestException("Maximum 2,000 rows per import");
  if (sheet.columnCount < 2)
    throw new BadRequestException(
      "The file needs at least two columns: one for the name and one for the phone number",
    );
  return sheet;
}
function cellText(v: ExcelJS.CellValue) {
  return v === null || v === undefined ? "" : String(v).trim();
}
/** Reads the header row and a few sample rows so the caller can pick which column is which. */
export async function inspectColdFile(file: ColdFile | undefined) {
  const sheet = await readColdSheet(file);
  const header = sheet.getRow(1);
  const columns = Array.from({ length: sheet.columnCount }, (_, i) => {
    const label = cellText(header.getCell(i + 1).value);
    return { index: i + 1, label: label || null };
  });
  const sample: string[][] = [];
  for (let r = 2; r <= Math.min(sheet.rowCount, 4); r++) {
    const row = sheet.getRow(r);
    sample.push(
      Array.from({ length: sheet.columnCount }, (_, i) =>
        cellText(row.getCell(i + 1).value),
      ),
    );
  }
  return { columns, sample, totalRows: sheet.rowCount - 1 };
}
export async function parseColdFile(
  file: ColdFile | undefined,
  mapping: ColdColumnMapping,
) {
  const sheet = await readColdSheet(file);
  if (
    !Number.isInteger(mapping.nameColumn) ||
    !Number.isInteger(mapping.phoneColumn) ||
    mapping.nameColumn < 1 ||
    mapping.phoneColumn < 1 ||
    mapping.nameColumn > sheet.columnCount ||
    mapping.phoneColumn > sheet.columnCount ||
    mapping.nameColumn === mapping.phoneColumn
  )
    throw new BadRequestException(
      "Choose two different columns for the name and the phone number",
    );
  const rows: ColdRow[] = [],
    errors: { row: number; reason: string }[] = [];
  let empty = 0;
  const seen = new Set<string>();
  let duplicate = 0;
  for (let i = 2; i <= sheet.rowCount; i++) {
    const row = sheet.getRow(i),
      n = row.getCell(mapping.nameColumn).value,
      p = row.getCell(mapping.phoneColumn).value;
    if ((n === null || n === "") && (p === null || p === "")) {
      empty++;
      continue;
    }
    if (typeof n !== "string" || !n.trim() || n.trim().length > 160) {
      errors.push({
        row: i,
        reason: "Name must be text between 1 and 160 characters",
      });
      continue;
    }
    if (typeof p !== "string") {
      errors.push({
        row: i,
        reason:
          "Phone must be text. Format the phone column as Text to preserve leading zeros and +.",
      });
      continue;
    }
    try {
      const phone = normalizePhone(
        p
          .trim()
          .replace(/[٠-٩۰-۹]/g, (c) =>
            String(
              "٠١٢٣٤٥٦٧٨٩".includes(c)
                ? "٠١٢٣٤٥٦٧٨٩".indexOf(c)
                : "۰۱۲۳۴۵۶۷۸۹".indexOf(c),
            ),
          ),
      );
      if (seen.has(phone)) {
        duplicate++;
        continue;
      }
      seen.add(phone);
      rows.push({ row: i, name: n.trim(), phone });
    } catch {
      errors.push({
        row: i,
        reason:
          "Use an Egyptian mobile (01…) or an international number (+country code).",
      });
    }
  }
  return {
    rows,
    errors,
    empty,
    duplicate,
    total: sheet.rowCount - 1,
    hash: createHash("sha256").update(file!.buffer).digest("hex"),
  };
}
export async function coldTemplate() {
  const w = new ExcelJS.Workbook(),
    s = w.addWorksheet("Cold calls");
  s.columns = [
    { header: "name", key: "name", width: 30 },
    { header: "phone", key: "phone", width: 25, style: { numFmt: "@" } },
  ];
  s.getRow(1).font = { bold: true };
  s.views = [{ state: "frozen", ySplit: 1 }];
  return Buffer.from(await w.xlsx.writeBuffer());
}
