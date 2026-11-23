import {
  Module,
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Req,
  ParseUUIDPipe,
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { IsString, Length, IsInt, Min, IsBoolean } from "class-validator";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { recordPlatformEvent } from "../../../infrastructure/outbox/domain-events.js";
class CityInput {
  @IsString() @Length(2, 100) nameEn!: string;
  @IsString() @Length(2, 100) nameAr!: string;
}
class CityUpdate extends CityInput {
  @IsInt() @Min(1) version!: number;
}
class CityArchive {
  @IsInt() @Min(1) version!: number;
  @IsBoolean() archived!: boolean;
}
const dto = (r: any) => ({
  id: r.id,
  nameEn: r.name_en,
  nameAr: r.name_ar,
  archived: r.archived,
  version: r.version,
});
@Injectable()
export class CitiesService {
  constructor(private readonly db: DatabaseService) {}
  async list(q: Record<string, string>) {
    if (
      Object.keys(q).some((k) => !["q", "archived"].includes(k)) ||
      !["true", "false", "all"].includes(q.archived ?? "false") ||
      (q.q?.length ?? 0) > 100
    )
      throw new BadRequestException("Invalid city filters");
    return this.db.platform(async (c) => ({
      items: (
        await c.query(
          "SELECT * FROM platform.cities WHERE ($1='all' OR archived=($1='true')) AND ($2='' OR strpos(lower(name_en||' '||name_ar),lower($2))>0) ORDER BY name_en,id",
          [q.archived ?? "false", q.q?.trim() ?? ""],
        )
      ).rows.map(dto),
    }));
  }
  async save(actor: string, b: CityInput | CityUpdate, id?: string) {
    const en = b.nameEn.trim(),
      ar = b.nameAr.trim();
    if (en.length < 2 || ar.length < 2)
      throw new BadRequestException("Enter both city names");
    try {
      return await this.db.platform(async (c) => {
        const old = id
          ? (
              await c.query(
                "SELECT * FROM platform.cities WHERE id=$1 FOR UPDATE",
                [id],
              )
            ).rows[0]
          : null;
        if (id && !old) throw new NotFoundException("City not found");
        if (old && old.version !== (b as CityUpdate).version)
          throw new ConflictException("City changed; refresh before saving");
        const row = old
          ? (
              await c.query(
                "UPDATE platform.cities SET name_en=$2,name_ar=$3,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",
                [id, en, ar],
              )
            ).rows[0]
          : (
              await c.query(
                "INSERT INTO platform.cities(name_en,name_ar) VALUES($1,$2) RETURNING *",
                [en, ar],
              )
            ).rows[0];
        await recordPlatformEvent(c, {
          actorId: actor,
          action: old ? "city.updated" : "city.created",
          resourceType: "city",
          resourceId: row.id,
          before: old ?? undefined,
          after: row,
          payload: { id: row.id },
        });
        return dto(row);
      });
    } catch (e: any) {
      if (e.code === "23505")
        throw new ConflictException(
          "City already exists, including deleted cities; restore it instead",
        );
      throw e;
    }
  }
  async archive(actor: string, id: string, b: CityArchive) {
    return this.db.platform(async (c) => {
      const old = (
        await c.query("SELECT * FROM platform.cities WHERE id=$1 FOR UPDATE", [
          id,
        ])
      ).rows[0];
      if (!old) throw new NotFoundException("City not found");
      if (old.version !== b.version)
        throw new ConflictException("City changed; refresh before saving");
      const row = (
        await c.query(
          "UPDATE platform.cities SET archived=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",
          [id, b.archived],
        )
      ).rows[0];
      await recordPlatformEvent(c, {
        actorId: actor,
        action: b.archived ? "city.archived" : "city.restored",
        resourceType: "city",
        resourceId: id,
        before: old,
        after: row,
        payload: { id },
      });
      return dto(row);
    });
  }
}
@Controller("admin/api/v1/cities")
@RequireAccess(["platform"], "co.view")
export class CitiesController {
  constructor(private readonly s: CitiesService) {}
  @Get() list(@Query() q: Record<string, string>) {
    return this.s.list(q);
  }
  @Post() @RequireAccess(["platform"], "co.create") create(
    @Req() r: AuthRequest,
    @Body() b: CityInput,
  ) {
    return this.s.save(r.principal.id, b);
  }
  @Post(":id") @RequireAccess(["platform"], "co.create") update(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: CityUpdate,
  ) {
    return this.s.save(r.principal.id, b, id);
  }
  @Post(":id/archive") @RequireAccess(["platform"], "co.create") archive(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: CityArchive,
  ) {
    return this.s.archive(r.principal.id, id, b);
  }
}
@Module({ controllers: [CitiesController], providers: [CitiesService] })
export class CitiesModule {}
