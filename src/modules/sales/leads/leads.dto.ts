import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;
export const STAGES = [
  "new",
  "qualified",
  "viewing",
  "offer",
  "contract",
  "won",
  "lost",
] as const;
export class SalesQuery {
  @IsOptional() @IsUUID() @ApiPropertyOptional() campaignId?: string;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  @ApiPropertyOptional({ type: Number, default: 1 })
  page = 1;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @ApiPropertyOptional({ type: Number, default: 50 })
  limit = 50;
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(trim)
  @ApiPropertyOptional({ type: String })
  q?: string;
  @IsOptional()
  @IsIn(STAGES)
  @ApiPropertyOptional({ type: String, enum: STAGES })
  stage?: string;
  @IsOptional()
  @IsIn(["active", "archived", "all"])
  @ApiPropertyOptional({ type: String })
  archived?: string;
}
export class SalesRequest {
  @IsUUID()
  @ApiProperty({ type: String, format: "uuid" })
  declare requestId: string;
}
export class LeadInput extends SalesRequest {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ type: String, nullable: true })
  campaignId?: string | null;
  @IsString()
  @Transform(trim)
  @MinLength(2)
  @MaxLength(160)
  @ApiProperty({ type: String })
  declare name: string;
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MinLength(2)
  @MaxLength(160)
  @ApiPropertyOptional({ type: String })
  nameAr?: string;
  @IsString()
  @MinLength(8)
  @MaxLength(40)
  @ApiProperty({ type: String })
  declare phone: string;
  @IsIn(["res", "com"]) @ApiProperty({ type: String }) declare segment: string;
  @IsString()
  @Transform(trim)
  @MaxLength(1000)
  @ApiProperty({ type: String })
  declare want: string;
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(1000)
  @ApiPropertyOptional({ type: String })
  wantAr?: string;
  @IsOptional()
  @Matches(/^(0|[1-9][0-9]{0,17})$/)
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: "Integer EGP minor units as a string",
  })
  budgetMinor?: string | null;
  @IsIn([
    "manual",
    "referral",
    "website",
    "phone",
    "walk_in",
    "social",
    "other",
  ])
  @ApiProperty({ type: String })
  declare source: string;
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ type: String, nullable: true, format: "uuid" })
  ownerId?: string | null;
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  @ApiPropertyOptional({ type: Number, nullable: true })
  score?: number | null;
  @IsOptional()
  @IsIn(["create", "link"])
  @ApiPropertyOptional({ type: String })
  duplicateMode?: string;
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ type: String, format: "uuid" })
  duplicateOf?: string;
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MinLength(10)
  @MaxLength(500)
  @ApiPropertyOptional({ type: String })
  reason?: string;
}
export class LeadUpdate extends LeadInput {
  @IsInt() @Min(0) @ApiProperty({ type: Number }) declare version: number;
}
export class StageChange extends SalesRequest {
  @IsInt() @Min(0) @ApiProperty({ type: Number }) declare version: number;
  @IsIn([...STAGES, "reopen"])
  @ApiProperty({ type: String, enum: [...STAGES, "reopen"] })
  declare stage: string;
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MinLength(10)
  @MaxLength(500)
  @ApiPropertyOptional({ type: String })
  reason?: string;
}
export class LeadArchive extends SalesRequest {
  @IsInt() @Min(0) @ApiProperty({ type: Number }) declare version: number;
  @IsIn(["archive", "restore"])
  @ApiProperty({ type: String })
  declare action: string;
  @IsString()
  @Transform(trim)
  @MinLength(10)
  @MaxLength(500)
  @ApiProperty({ type: String })
  declare reason: string;
}
export class LeadNote extends SalesRequest {
  @IsInt() @Min(0) @ApiProperty({ type: Number }) declare version: number;
  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(2000)
  @ApiProperty({ type: String })
  declare note: string;
}
export class ActivityQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @ApiPropertyOptional({ type: Number, default: 1 })
  page = 1;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @ApiPropertyOptional({ type: Number, default: 50 })
  limit = 50;
}
export class DealInput extends SalesRequest {
  @IsUUID()
  @ApiProperty({ type: String, format: "uuid" })
  declare leadId: string;
  @IsInt() @Min(0) @ApiProperty({ type: Number }) declare version: number;
  @IsString()
  @Transform(trim)
  @MinLength(2)
  @MaxLength(200)
  @ApiProperty({ type: String })
  declare title: string;
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MinLength(2)
  @MaxLength(200)
  @ApiPropertyOptional({ type: String })
  titleAr?: string;
  @IsIn(["sale", "lease"]) @ApiProperty({ type: String }) declare type: string;
  @Matches(/^(0|[1-9][0-9]{0,17})$/)
  @ApiProperty({
    type: String,
    description: "Integer EGP minor units as a string",
  })
  declare valueMinor: string;
}
export class DealUpdate extends SalesRequest {
  @IsInt() @Min(0) @ApiProperty({ type: Number }) declare version: number;
  @IsString()
  @Transform(trim)
  @MinLength(2)
  @MaxLength(200)
  @ApiProperty({ type: String })
  declare title: string;
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MinLength(2)
  @MaxLength(200)
  @ApiPropertyOptional({ type: String })
  titleAr?: string;
  @IsIn(["sale", "lease"]) @ApiProperty({ type: String }) declare type: string;
  @Matches(/^(0|[1-9][0-9]{0,17})$/)
  @ApiProperty({
    type: String,
    description: "Integer EGP minor units as a string",
  })
  declare valueMinor: string;
}

export class LeadContact extends SalesRequest {
  @IsInt() @Min(0) @ApiProperty() declare version: number;
  @IsIn(["phone", "email", "meeting", "other"])
  @ApiProperty()
  declare channel: string;
  @IsString()
  @Transform(trim)
  @MinLength(10)
  @MaxLength(1000)
  @ApiProperty()
  declare note: string;
}
