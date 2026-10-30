import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import type { Principal } from "../../../common/auth/access.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { recordTenantEvent } from "../../../infrastructure/outbox/domain-events.js";
import { SalesService } from "../../sales/leads/sales.service.js";
import type { SalesQuery } from "../../sales/leads/leads.dto.js";
import type {
  InventoryQuery,
  ProjectInput,
  ProjectUpdate,
  PhaseInput,
  PhaseUpdate,
  BuildingInput,
  BuildingUpdate,
  UnitInput,
  UnitUpdate,
  InventoryArchive,
} from "./inventory.dto.js";
const iso = (v: any) => (v ? new Date(v).toISOString() : null);
const text = (en: string, ar?: string) => ({ en, ar: ar ?? en });
const UNIT = `SELECT u.*,u.price_minor::text AS price_minor,u.area::text AS area,b.code AS building_code,b.name AS building_name,ph.id AS phase_id,ph.name AS phase_name,p.id AS project_id,p.name AS project_name,p.archived_at AS project_archived_at FROM tenant.units u LEFT JOIN tenant.project_buildings b ON b.company_id=u.company_id AND b.id=u.building_id LEFT JOIN tenant.project_phases ph ON ph.company_id=b.company_id AND ph.id=b.phase_id LEFT JOIN tenant.projects p ON p.company_id=ph.company_id AND p.id=ph.project_id`;
export function unitDto(u: any) {
  return {
    id: u.id,
    code: u.code,
    buildingId: u.building_id,
    building: u.building_name,
    phaseId: u.phase_id,
    phase: u.phase_name,
    projectId: u.project_id,
    project: u.project_name ?? u.location,
    projectArchived: !!u.project_archived_at,
    listing: u.listing,
    location: u.location,
    type: u.type,
    bedrooms: u.bedrooms,
    area: u.area,
    view: u.view_label,
    floor: u.floor,
    priceMinor: u.price_minor,
    currency: u.currency,
    status: u.status,
    archivedAt: iso(u.archived_at),
    version: u.version,
    sample: !!u.seed_key,
  };
}
function projectDto(p: any) {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    developer: p.developer,
    location: p.location,
    segment: p.segment,
    version: p.version,
    archivedAt: iso(p.archived_at),
    sample: !!p.seed_key,
    total: Number(p.total ?? 0),
    available: Number(p.available ?? 0),
    heldOrReserved: Number(p.held ?? 0),
    sold: Number(p.sold ?? 0),
    underContract: Number(p.under_contract ?? 0),
    fromPriceMinor: p.from_price ?? null,
    currency: "EGP",
  };
}
const COUNTS = `SELECT p.*,count(u.id)::int AS total,count(u.id) FILTER(WHERE u.status='available')::int AS available,count(u.id) FILTER(WHERE u.status IN ('hold','reserved'))::int AS held,count(u.id) FILTER(WHERE u.status='sold')::int AS sold,count(u.id) FILTER(WHERE u.status='under_contract')::int AS under_contract,min(u.price_minor) FILTER(WHERE u.status='available')::text AS from_price FROM tenant.projects p LEFT JOIN tenant.project_phases ph ON ph.company_id=p.company_id AND ph.project_id=p.id LEFT JOIN tenant.project_buildings b ON b.company_id=ph.company_id AND b.phase_id=ph.id LEFT JOIN tenant.units u ON u.company_id=b.company_id AND u.building_id=b.id AND u.archived_at IS NULL`;
@Injectable()
export class InventoryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sales: SalesService,
  ) {}
  async row(c: PoolClient, p: Principal, table: string, id: string) {
    const row = (
      await c.query(
        `SELECT * FROM tenant.${table} WHERE company_id=$1 AND id=$2 FOR UPDATE`,
        [p.companyId, id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("Inventory record not found");
    return row;
  }
  version(row: any, v: number) {
    if (row.version !== v)
      throw new ConflictException("Record changed. Refresh before saving.");
  }
  async quota(c: PoolClient, p: Principal, resource: "projects" | "listings") {
    const policy = (
      await c.query(
        "SELECT * FROM platform.inventory_policy WHERE company_id=$1",
        [p.companyId],
      )
    ).rows[0];
    if (!policy?.subscription_id)
      throw new ForbiddenException("A current subscription is required");
    const limit = policy[resource + "_limit"];
    if (limit === null) return;
    const n = (
      await c.query(
        `SELECT count(*)::int AS n FROM tenant.${resource === "projects" ? "projects" : "units"} WHERE company_id=$1 AND archived_at IS NULL`,
        [p.companyId],
      )
    ).rows[0].n;
    if (n >= Number(limit))
      throw new ConflictException(
        "Your " + resource + " limit has been reached",
      );
  }
  async event(
    c: PoolClient,
    p: Principal,
    action: string,
    type: string,
    row: any,
    before?: any,
  ) {
    await recordTenantEvent(c, {
      companyId: p.companyId!,
      actorId: p.id,
      action,
      resourceType: type,
      resourceId: row.id,
      before,
      after: row,
      payload: { id: row.id, code: row.code },
    });
  }
  async mutate(
    p: Principal,
    permission: string,
    op: string,
    b: any,
    work: (c: PoolClient) => Promise<any>,
  ) {
    try {
      return await this.sales.write(p, permission, op, b, work);
    } catch (e: any) {
      if (e.code === "23505")
        throw new ConflictException("This inventory code already exists");
      throw e;
    }
  }
  async projects(p: Principal, q: SalesQuery) {
    await this.sales.access(p, "projects.read");
    return this.db.tenant(
      p.companyId!,
      async (c) => {
        const args: any[] = [p.companyId],
          w = ["p.company_id=$1"];
        if (q.archived !== "all")
          w.push(
            q.archived === "archived"
              ? "p.archived_at IS NOT NULL"
              : "p.archived_at IS NULL",
          );
        if (q.q) {
          args.push("%" + q.q.replace(/[\\%_]/g, "\\$&") + "%");
          w.push(
            `(p.code ILIKE $2 OR p.name->>'en' ILIKE $2 OR p.name->>'ar' ILIKE $2)`,
          );
        }
        const where = w.join(" AND ");
        const total = (
          await c.query(
            "SELECT count(*)::int AS n FROM tenant.projects p WHERE " + where,
            args,
          )
        ).rows[0].n;
        const rows = (
          await c.query(
            COUNTS +
              " WHERE " +
              where +
              " GROUP BY p.id ORDER BY p.created_at DESC,p.id LIMIT $" +
              (args.length + 1) +
              " OFFSET $" +
              (args.length + 2),
            [...args, q.limit, (q.page - 1) * q.limit],
          )
        ).rows;
        return {
          items: rows.map(projectDto),
          total,
          page: q.page,
          limit: q.limit,
        };
      },
      true,
    );
  }
  async project(p: Principal, id: string) {
    await this.sales.access(p, "projects.read");
    return this.db.tenant(
      p.companyId!,
      async (c) => {
        const row = (
          await c.query(
            COUNTS + " WHERE p.company_id=$1 AND p.id=$2 GROUP BY p.id",
            [p.companyId, id],
          )
        ).rows[0];
        if (!row) throw new NotFoundException("Project not found");
        const phases = (
          await c.query(
            "SELECT * FROM tenant.project_phases WHERE company_id=$1 AND project_id=$2 ORDER BY code,id",
            [p.companyId, id],
          )
        ).rows;
        const buildings = (
          await c.query(
            "SELECT b.* FROM tenant.project_buildings b JOIN tenant.project_phases ph ON ph.company_id=b.company_id AND ph.id=b.phase_id WHERE b.company_id=$1 AND ph.project_id=$2 ORDER BY b.code,b.id",
            [p.companyId, id],
          )
        ).rows;
        return {
          ...projectDto(row),
          phases: phases.map((ph) => ({
            id: ph.id,
            code: ph.code,
            name: ph.name,
            deliveryYear: ph.delivery_year,
            version: ph.version,
            buildings: buildings
              .filter((b) => b.phase_id === ph.id)
              .map((b) => ({
                id: b.id,
                code: b.code,
                name: b.name,
                floors: b.floors,
                version: b.version,
              })),
          })),
        };
      },
      true,
    );
  }
  async createProject(p: Principal, b: ProjectInput) {
    return this.mutate(p, "projects.manage", "project.create", b, async (c) => {
      await this.quota(c, p, "projects");
      const row = (
        await c.query(
          "INSERT INTO tenant.projects(company_id,code,name,developer,location,segment) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
          [
            p.companyId,
            b.code.toUpperCase(),
            text(b.name, b.nameAr),
            text(b.developer, b.developerAr),
            text(b.location, b.locationAr),
            b.segment,
          ],
        )
      ).rows[0];
      await this.event(c, p, "project.created", "project", row);
      return projectDto(row);
    });
  }
  async updateProject(p: Principal, id: string, b: ProjectUpdate) {
    return this.mutate(
      p,
      "projects.manage",
      "project.update:" + id,
      b,
      async (c) => {
        const old = await this.row(c, p, "projects", id);
        this.version(old, b.version);
        if (old.archived_at)
          throw new ConflictException("Restore the project before editing");
        const row = (
          await c.query(
            "UPDATE tenant.projects SET code=$3,name=$4,developer=$5,location=$6,segment=$7,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING *",
            [
              p.companyId,
              id,
              b.code.toUpperCase(),
              text(b.name, b.nameAr),
              text(b.developer, b.developerAr),
              text(b.location, b.locationAr),
              b.segment,
            ],
          )
        ).rows[0];
        await this.event(c, p, "project.updated", "project", row, old);
        return projectDto(row);
      },
    );
  }
  async phase(
    p: Principal,
    id: string,
    b: PhaseInput | PhaseUpdate,
    phaseId?: string,
  ) {
    return this.mutate(
      p,
      "projects.manage",
      "phase.save:" + id + ":" + (phaseId ?? "new"),
      b,
      async (c) => {
        const project = await this.row(c, p, "projects", id);
        if (project.archived_at)
          throw new ConflictException("Project is archived");
        let old: any;
        if (phaseId) {
          old = await this.row(c, p, "project_phases", phaseId);
          if (old.project_id !== id) throw new NotFoundException();
          this.version(old, (b as PhaseUpdate).version);
        }
        const row = (
          await c.query(
            phaseId
              ? "UPDATE tenant.project_phases SET code=$3,name=$4,delivery_year=$5,version=version+1 WHERE company_id=$1 AND id=$2 RETURNING *"
              : "INSERT INTO tenant.project_phases(company_id,project_id,code,name,delivery_year) VALUES($1,$2,$3,$4,$5) RETURNING *",
            [
              p.companyId,
              phaseId ?? id,
              b.code.toUpperCase(),
              text(b.name, b.nameAr),
              b.deliveryYear,
            ],
          )
        ).rows[0];
        await this.event(
          c,
          p,
          old ? "phase.updated" : "phase.created",
          "project_phase",
          row,
          old,
        );
        return {
          id: row.id,
          code: row.code,
          name: row.name,
          deliveryYear: row.delivery_year,
          version: row.version,
        };
      },
    );
  }
  async building(
    p: Principal,
    phaseId: string,
    b: BuildingInput | BuildingUpdate,
    buildingId?: string,
  ) {
    return this.mutate(
      p,
      "projects.manage",
      "building.save:" + phaseId + ":" + (buildingId ?? "new"),
      b,
      async (c) => {
        const phase = await this.row(c, p, "project_phases", phaseId),
          project = await this.row(c, p, "projects", phase.project_id);
        if (project.archived_at)
          throw new ConflictException("Project is archived");
        let old: any;
        if (buildingId) {
          old = await this.row(c, p, "project_buildings", buildingId);
          if (old.phase_id !== phaseId) throw new NotFoundException();
          this.version(old, (b as BuildingUpdate).version);
          if (
            (
              await c.query(
                "SELECT 1 FROM tenant.units WHERE company_id=$1 AND building_id=$2 AND floor>$3 LIMIT 1",
                [p.companyId, buildingId, b.floors],
              )
            ).rowCount
          )
            throw new ConflictException(
              "Existing unit floor exceeds this building height",
            );
        }
        const row = (
          await c.query(
            buildingId
              ? "UPDATE tenant.project_buildings SET code=$3,name=$4,floors=$5,version=version+1 WHERE company_id=$1 AND id=$2 RETURNING *"
              : "INSERT INTO tenant.project_buildings(company_id,phase_id,code,name,floors) VALUES($1,$2,$3,$4,$5) RETURNING *",
            [
              p.companyId,
              buildingId ?? phaseId,
              b.code.toUpperCase(),
              text(b.name, b.nameAr),
              b.floors,
            ],
          )
        ).rows[0];
        await this.event(
          c,
          p,
          old ? "building.updated" : "building.created",
          "project_building",
          row,
          old,
        );
        return {
          id: row.id,
          code: row.code,
          name: row.name,
          floors: row.floors,
          version: row.version,
        };
      },
    );
  }
  async units(p: Principal, q: InventoryQuery) {
    await this.sales.access(p, "units.read");
    return this.db.tenant(
      p.companyId!,
      async (c) => {
        const args: any[] = [p.companyId],
          w = ["u.company_id=$1"];
        if (q.archived !== "all")
          w.push(
            q.archived === "archived"
              ? "u.archived_at IS NOT NULL"
              : "u.archived_at IS NULL",
          );
        for (const [key, col] of [
          ["type", "u.type"],
          ["status", "u.status"],
          ["listing", "u.listing"],
          ["buildingId", "u.building_id"],
          ["projectId", "p.id"],
        ] as const)
          if (q[key]) {
            args.push(q[key]);
            w.push(col + "=$" + args.length);
          }
        if (q.q) {
          args.push("%" + q.q.replace(/[\\%_]/g, "\\$&") + "%");
          w.push(
            `(u.code ILIKE $${args.length} OR u.location->>'en' ILIKE $${args.length} OR u.location->>'ar' ILIKE $${args.length} OR p.name->>'en' ILIKE $${args.length} OR p.name->>'ar' ILIKE $${args.length})`,
          );
        }
        const where = " WHERE " + w.join(" AND ");
        const total = (
          await c.query(
            "SELECT count(*)::int AS n FROM (" + UNIT + where + ") rows",
            args,
          )
        ).rows[0].n;
        const rows = (
          await c.query(
            UNIT +
              where +
              " ORDER BY u.floor DESC NULLS LAST,u.code,u.id LIMIT $" +
              (args.length + 1) +
              " OFFSET $" +
              (args.length + 2),
            [...args, q.limit, (q.page - 1) * q.limit],
          )
        ).rows;
        return {
          items: rows.map(unitDto),
          total,
          page: q.page,
          limit: q.limit,
        };
      },
      true,
    );
  }
  async unit(p: Principal, id: string) {
    await this.sales.access(p, "units.read");
    return this.db.tenant(p.companyId!, async (c) => {
      const row = (
        await c.query(UNIT + " WHERE u.company_id=$1 AND u.id=$2", [
          p.companyId,
          id,
        ])
      ).rows[0];
      if (!row) throw new NotFoundException("Unit not found");
      return unitDto(row);
    });
  }
  async validateUnit(c: PoolClient, p: Principal, b: UnitInput) {
    if (b.listing === "primary" && !b.buildingId)
      throw new BadRequestException("Primary inventory requires a building");
    if (b.buildingId) {
      if (!p.permissions.includes("projects.read"))
        throw new ForbiddenException();
      const parent = (
        await c.query(
          "SELECT b.floors,p.archived_at FROM tenant.project_buildings b JOIN tenant.project_phases ph ON ph.company_id=b.company_id AND ph.id=b.phase_id JOIN tenant.projects p ON p.company_id=ph.company_id AND p.id=ph.project_id WHERE b.company_id=$1 AND b.id=$2",
          [p.companyId, b.buildingId],
        )
      ).rows[0];
      if (!parent || parent.archived_at)
        throw new BadRequestException("Select an active company building");
      if (b.floor === undefined || b.floor === null || b.floor > parent.floors)
        throw new BadRequestException("Choose a floor within this building");
    }
  }
  async saveUnit(p: Principal, b: UnitInput | UnitUpdate, id?: string) {
    return this.mutate(
      p,
      "units.manage",
      "unit.save:" + (id ?? "new"),
      b,
      async (c) => {
        let old: any;
        if (id) {
          old = await this.row(c, p, "units", id);
          this.version(old, (b as UnitUpdate).version);
          if (old.archived_at || old.status !== "available")
            throw new ConflictException(
              "Only available, active units can be edited",
            );
        } else await this.quota(c, p, "listings");
        await this.validateUnit(c, p, b);
        const values = [
          p.companyId,
          id ?? b.code.toUpperCase(),
          ...(id ? [b.code.toUpperCase()] : []),
          b.buildingId ?? null,
          b.listing,
          text(b.location, b.locationAr),
          b.type,
          b.bedrooms ?? null,
          b.area,
          text(b.view, b.viewAr),
          b.floor ?? null,
          b.priceMinor,
        ];
        const row = (
          await c.query(
            id
              ? "UPDATE tenant.units SET code=$3,building_id=$4,listing=$5,location=$6,type=$7,bedrooms=$8,area=$9,view_label=$10,floor=$11,price_minor=$12,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING *"
              : "INSERT INTO tenant.units(company_id,code,building_id,listing,location,type,bedrooms,area,view_label,floor,price_minor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
            values,
          )
        ).rows[0];
        await this.event(
          c,
          p,
          old ? "unit.updated" : "unit.created",
          "unit",
          row,
          old,
        );
        return unitDto({
          ...row,
          price_minor: String(row.price_minor),
          area: String(row.area),
        });
      },
    );
  }
  async archive(
    p: Principal,
    type: "projects" | "units",
    id: string,
    b: InventoryArchive,
  ) {
    const perm = type === "projects" ? "projects.manage" : "units.manage";
    return this.mutate(p, perm, type + ".archive:" + id, b, async (c) => {
      const old = await this.row(c, p, type, id);
      this.version(old, b.version);
      const archive = b.action === "archive";
      if (archive === !!old.archived_at)
        throw new ConflictException("Record already has this state");
      if (type === "units" && old.status !== "available")
        throw new ConflictException(
          "Only available units can be archived or restored",
        );
      if (
        type === "projects" &&
        (
          await c.query(
            "SELECT 1 FROM tenant.units u JOIN tenant.project_buildings bu ON bu.company_id=u.company_id AND bu.id=u.building_id JOIN tenant.project_phases ph ON ph.company_id=bu.company_id AND ph.id=bu.phase_id WHERE u.company_id=$1 AND ph.project_id=$2 AND u.archived_at IS NULL LIMIT 1",
            [p.companyId, id],
          )
        ).rowCount
      )
        throw new ConflictException(
          "Archive active units before archiving their project",
        );
      if (!archive)
        await this.quota(c, p, type === "projects" ? "projects" : "listings");
      if (type === "units" && !archive && old.building_id) {
        const parent = (
          await c.query(
            "SELECT p.archived_at FROM tenant.project_buildings b JOIN tenant.project_phases ph ON ph.company_id=b.company_id AND ph.id=b.phase_id JOIN tenant.projects p ON p.company_id=ph.company_id AND p.id=ph.project_id WHERE b.company_id=$1 AND b.id=$2",
            [p.companyId, old.building_id],
          )
        ).rows[0];
        if (parent?.archived_at)
          throw new ConflictException("Restore the project first");
      }
      const row = (
        await c.query(
          `UPDATE tenant.${type} SET archived_at=CASE WHEN $3 THEN now() ELSE NULL END,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING *`,
          [p.companyId, id, archive],
        )
      ).rows[0];
      await this.event(
        c,
        p,
        (type === "projects" ? "project" : "unit") +
          (archive ? ".archived" : ".restored"),
        type === "projects" ? "project" : "unit",
        row,
        old,
      );
      return {
        id: row.id,
        version: row.version,
        archivedAt: iso(row.archived_at),
      };
    });
  }
}
