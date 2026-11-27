import { ASSIGNABLE_COMPANY_ROLES } from "../../../common/auth/company-roles.js";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  IsEmail,
  IsArray,
  IsUUID,
  IsInt,
  Min,
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";
const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;
export const TEAM_ROLES = ASSIGNABLE_COMPANY_ROLES;
export type TeamRole = (typeof TEAM_ROLES)[number];
export class TeamInvite {
  @IsString()
  @Transform(trim)
  @MinLength(2)
  @MaxLength(120)
  declare name: string;
  @IsEmail()
  @Transform(trim)
  @MaxLength(254)
  declare email: string;
  @IsOptional()
  @IsIn(TEAM_ROLES)
  @ApiPropertyOptional({ type: String, enum: TEAM_ROLES })
  declare role?: TeamRole;
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @ArrayUnique()
  @IsIn(TEAM_ROLES, { each: true })
  @ApiPropertyOptional({ type: [String], enum: TEAM_ROLES })
  declare roles?: TeamRole[];
}
export class TeamStatus {
  @IsIn(["disable", "enable"])
  @ApiProperty({ type: String, enum: ["disable", "enable"] })
  declare action: "disable" | "enable";
}
export class TeamActivate {
  @IsString() @Matches(/^[a-f0-9]{64}$/) declare token: string;
  @IsString() @MinLength(12) @MaxLength(256) declare password: string;
}
export class TeamQuery {
  @IsOptional()
  @IsIn(["all", "invited", "active", "disabled"])
  @ApiPropertyOptional({ type: String })
  status?: string;
}

export class EmployeeRole {
  @IsIn(TEAM_ROLES) @ApiProperty({ enum: TEAM_ROLES }) declare role: TeamRole;
}
export class SalesTeamInput {
  @ApiProperty({ minLength: 2, maxLength: 120 })
  @IsString()
  @Transform(trim)
  @MinLength(2)
  @MaxLength(120)
  declare name: string;
  @ApiProperty({ format: "uuid" }) @IsUUID() declare leadUserId: string;
  @ApiProperty({ type: [String], maxItems: 500 })
  @IsArray()
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  declare memberUserIds: string[];
}
export class SalesTeamUpdate extends SalesTeamInput {
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  declare version: number;
}

export class EmployeeManager {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({
    format: "uuid",
    description:
      "The user's direct manager one rung up the sales ladder (team leader → sales manager → sales director → head of sales); null clears it.",
  })
  declare reportsToUserId?: string | null;
  @IsInt() @Min(0) @ApiProperty({ minimum: 0 }) declare version: number;
}
export class EmployeeRoles {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @ArrayUnique()
  @IsIn(TEAM_ROLES, { each: true })
  @ApiProperty({ type: [String], enum: TEAM_ROLES })
  declare roles: TeamRole[];
  @IsInt() @Min(0) @ApiProperty({ minimum: 0 }) declare version: number;
}
