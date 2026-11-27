import { ApiProperty } from "@nestjs/swagger";
import {
  IsArray,
  IsIn,
  IsInt,
  Min,
  ValidateNested,
  ValidateIf,
} from "class-validator";
import { Type } from "class-transformer";
import { SalesRequest } from "../leads/leads.dto.js";

/** The brokerage sales ladder's individual-contributor and management ranks
 * -- not sales_admin, which is an administrative role with no target of its
 * own. */
export const COMMISSION_ROLE_KEYS = [
  "property_advisor",
  "property_consultant",
  "senior",
  "expert",
  "team_leader",
  "sales_manager",
  "sales_director",
  "head_of_sales",
] as const;
export type CommissionRoleKey = (typeof COMMISSION_ROLE_KEYS)[number];
/** Ranks that manage people below them and so can "absorb" every junior
 * layer's rate when they personally sell a deal (see
 * CommissionAbsorptionRateInput). */
export const COMMISSION_MANAGER_ROLE_KEYS = [
  "team_leader",
  "sales_manager",
  "sales_director",
  "head_of_sales",
] as const;
export type CommissionManagerRoleKey =
  (typeof COMMISSION_MANAGER_ROLE_KEYS)[number];

export class CommissionAbsorptionRateInput {
  @IsIn(COMMISSION_ROLE_KEYS)
  @ApiProperty({ enum: COMMISSION_ROLE_KEYS })
  roleKey!: CommissionRoleKey;
  @IsInt() @Min(0) @ApiProperty() ratePerMillion!: number;
}

export class CommissionTierInput {
  @IsIn(["volume", "percent"])
  @ApiProperty({ enum: ["volume", "percent"] })
  kind!: "volume" | "percent";
  /** Quarterly EGP volume achieved (kind="volume") or % of target achieved
   * (kind="percent", e.g. 50, 100, 150) at or above which this tier applies. */
  @IsInt() @Min(0) @ApiProperty() threshold!: number;
  /** Commission in whole EGP per 1,000,000 EGP of (quarterly) sales. */
  @IsInt() @Min(0) @ApiProperty() ratePerMillion!: number;
}
export class CommissionRoleInput {
  @IsIn(COMMISSION_ROLE_KEYS)
  @ApiProperty({ enum: COMMISSION_ROLE_KEYS })
  roleKey!: CommissionRoleKey;
  @IsInt() @Min(0) @ApiProperty() monthlyTarget!: number;
  @IsInt() @Min(0) @ApiProperty() quarterlyTarget!: number;
  @IsInt() @Min(0) @ApiProperty() version!: number;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CommissionTierInput)
  @ApiProperty({ type: [CommissionTierInput] })
  tiers!: CommissionTierInput[];
  /** Only meaningful for team_leader and up: the flat rate this rank is paid
   * for each junior rank it absorbs when it personally sells a deal. Must be
   * empty for property_advisor..expert, which have no one below them. */
  @ValidateIf((o) => COMMISSION_MANAGER_ROLE_KEYS.includes(o.roleKey))
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CommissionAbsorptionRateInput)
  @ApiProperty({ type: [CommissionAbsorptionRateInput] })
  absorptionRates!: CommissionAbsorptionRateInput[];
}
export class CommissionSchemeInput extends SalesRequest {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CommissionRoleInput)
  @ApiProperty({ type: [CommissionRoleInput] })
  roles!: CommissionRoleInput[];
}
