import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { SalesRequest } from "../leads/leads.dto.js";
const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;
const trimArray = ({ value }: { value: unknown }) =>
  Array.isArray(value)
    ? value.map((v) => (typeof v === "string" ? v.trim() : v)).filter(Boolean)
    : value;
export const CONTACT_TYPES = [
  "buyer",
  "seller",
  "landlord",
  "tenant",
  "investor",
  "developer",
] as const;
export class ContactQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  @ApiPropertyOptional({ default: 1 })
  page = 1;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @ApiPropertyOptional({ default: 50 })
  limit = 50;
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(100)
  @ApiPropertyOptional()
  q?: string;
  @IsOptional()
  @IsIn(CONTACT_TYPES)
  @ApiPropertyOptional({ enum: CONTACT_TYPES })
  type?: string;
  @IsOptional()
  @IsIn(["active", "archived", "all"])
  @ApiPropertyOptional()
  archived?: string;
}
export class ContactInput extends SalesRequest {
  @IsIn(CONTACT_TYPES)
  @ApiProperty({ enum: CONTACT_TYPES })
  declare type: string;
  @IsString()
  @Transform(trim)
  @MinLength(2)
  @MaxLength(160)
  @ApiProperty()
  declare name: string;
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MinLength(2)
  @MaxLength(160)
  @ApiPropertyOptional()
  nameAr?: string;
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(160)
  @ApiPropertyOptional()
  companyName?: string;
  @IsOptional()
  @IsArray()
  @Transform(trimArray)
  @ApiPropertyOptional({ type: [String] })
  phones?: string[];
  @IsOptional()
  @IsArray()
  @Transform(trimArray)
  @ApiPropertyOptional({ type: [String] })
  emails?: string[];
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(120)
  @ApiPropertyOptional()
  area?: string;
  @IsOptional()
  @IsArray()
  @Transform(trimArray)
  @ApiPropertyOptional({ type: [String] })
  tags?: string[];
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ nullable: true })
  ownerId?: string | null;
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(2000)
  @ApiPropertyOptional()
  notes?: string;
}
export class ContactUpdate extends ContactInput {
  @IsInt() @Min(0) @ApiProperty() declare version: number;
}
export class ContactArchive extends SalesRequest {
  @IsInt() @Min(0) @ApiProperty() declare version: number;
  @IsIn(["archive", "restore"]) @ApiProperty() declare action: string;
  @IsString()
  @Transform(trim)
  @MinLength(10)
  @MaxLength(500)
  @ApiProperty()
  declare reason: string;
}
export class ContactNote extends SalesRequest {
  @IsInt() @Min(0) @ApiProperty() declare version: number;
  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(2000)
  @ApiProperty()
  declare note: string;
}
