import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { z } from "zod";
import { ENV, type Environment } from "../../../config/env.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
const row = z.object({
  date: z.iso.date(),
  name: z.string().trim().min(1).max(240),
  localName: z.string().trim().max(240),
  countryCode: z.literal("EG"),
  global: z.boolean(),
  types: z.array(z.string()),
});
export type Holiday = { date: string; name: string; localName: string };
const TTL = 86400000;
@Injectable()
export class EgyptHolidaysService {
  private readonly pending = new Map<number, Promise<any>>();
  constructor(
    private readonly db: DatabaseService,
    @Inject(ENV) private readonly env: Environment,
  ) {}
  async get(
    year: number,
    allowStale = false,
  ): Promise<{
    holidays: Holiday[];
    year: number;
    source: string;
    fetchedAt: string | null;
    stale: boolean;
    available: boolean;
  }> {
    if (!Number.isInteger(year) || year < 2000 || year > 2200)
      throw new ServiceUnavailableException("Invalid holiday year");
    const cached = (
      await this.db.platform((c) =>
        c.query(
          "SELECT holidays,fetched_at FROM platform.egypt_public_holidays WHERE year=$1",
          [year],
        ),
      )
    ).rows[0];
    const dto = (r: any, stale = false) => ({
      holidays: r?.holidays ?? [],
      year,
      source: "Nager.Date",
      fetchedAt: r ? new Date(r.fetched_at).toISOString() : null,
      stale,
      available: !!r,
    });
    if (cached && Date.now() - new Date(cached.fetched_at).getTime() < TTL)
      return dto(cached);
    try {
      let request = this.pending.get(year);
      if (!request) {
        request = this.refresh(year);
        this.pending.set(year, request);
      }
      try {
        return dto(await request);
      } finally {
        if (this.pending.get(year) === request) this.pending.delete(year);
      }
    } catch {
      if (allowStale) return dto(cached, true);
      throw new ServiceUnavailableException(
        "Egypt public holidays are temporarily unavailable. Retry before submitting or approving leave.",
      );
    }
  }
  private async refresh(year: number) {
    const response = await fetch(
      `${this.env.EGYPT_HOLIDAYS_BASE_URL}/PublicHolidays/${year}/EG`,
      {
        signal: AbortSignal.timeout(8000),
        redirect: "error",
        headers: { Accept: "application/json" },
      },
    );
    if (!response.ok || !response.body)
      throw Error("Holiday provider unavailable");
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 262144) {
        await reader.cancel();
        throw Error("Holiday response too large");
      }
      chunks.push(value);
    }
    const rows = z
      .array(row)
      .min(1)
      .max(366)
      .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (rows.some((r) => !r.date.startsWith(year + "-")))
      throw Error("Unexpected holiday year");
    const dates = new Map<string, Holiday>();
    for (const r of rows.filter(
      (r) => r.global && r.types.includes("Public"),
    )) {
      const old = dates.get(r.date);
      dates.set(r.date, {
        date: r.date,
        name: old ? old.name + " / " + r.name : r.name,
        localName: old ? old.localName + " / " + r.localName : r.localName,
      });
    }
    const holidays = [...dates.values()].sort((a, b) =>
      a.date.localeCompare(b.date),
    );
    if (!holidays.length) throw Error("No national holidays");
    return (
      await this.db.platform((c) =>
        c.query(
          "INSERT INTO platform.egypt_public_holidays(year,holidays) VALUES($1,$2) ON CONFLICT(year) DO UPDATE SET holidays=$2,fetched_at=now() RETURNING holidays,fetched_at",
          [year, JSON.stringify(holidays)],
        ),
      )
    ).rows[0];
  }
}
