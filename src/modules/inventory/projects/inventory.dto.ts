import { Transform, Type } from "class-transformer";
import {
  IsString,
  IsIn,
  IsOptional,
  IsInt,
  IsUUID,
  Matches,
  Min,
  Max,
  Length,
  IsNumber,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SalesRequest, SalesQuery } from "../../sales/leads/leads.dto.js";
const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;
export class InventoryQuery extends SalesQuery {
  @IsOptional()
  @IsIn(["available", "hold", "reserved", "under_contract", "sold"])
  @ApiPropertyOptional()
  status?: string;
  @IsOptional()
  @IsIn(["apt", "villa", "office", "retail"])
  @ApiPropertyOptional()
  type?: string;
  @IsOptional()
  @IsIn(["primary", "resale", "rental"])
  @ApiPropertyOptional()
  listing?: string;
  @IsOptional() @IsUUID() @ApiPropertyOptional() buildingId?: string;
  @IsOptional() @IsUUID() @ApiPropertyOptional() projectId?: string;
}
export class InventoryRevision extends SalesRequest {
  @IsInt() @Min(0) @ApiProperty() declare version: number;
}
export class ProjectInput extends SalesRequest {
  @IsString()
  @Transform(trim)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9_-]{1,49}$/)
  @ApiProperty()
  declare code: string;
  @IsString()
  @Transform(trim)
  @Length(2, 160)
  @ApiProperty()
  declare name: string;
  @IsOptional()
  @IsString()
  @Transform(trim)
  @Length(2, 160)
  @ApiPropertyOptional()
  nameAr?: string;
  @IsString()
  @Transform(trim)
  @Length(2, 160)
  @ApiProperty()
  declare developer: string;
  @IsOptional()
  @IsString()
  @Transform(trim)
  @Length(2, 160)
  @ApiPropertyOptional()
  developerAr?: string;
  @IsString()
  @Transform(trim)
  @Length(2, 200)
  @ApiProperty()
  declare location: string;
  @IsOptional()
  @IsString()
  @Transform(trim)
  @Length(2, 200)
  @ApiPropertyOptional()
  locationAr?: string;
  @IsIn(["res", "com"]) @ApiProperty() declare segment: string;
}
export class ProjectUpdate extends ProjectInput {
  @IsInt() @Min(0) @ApiProperty() declare version: number;
}
export class PhaseInput extends SalesRequest {
  @IsString()
  @Transform(trim)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9_-]{1,49}$/)
  @ApiProperty()
  declare code: string;
  @IsString()
  @Transform(trim)
  @Length(2, 160)
  @ApiProperty()
  declare name: string;
  @IsOptional()
  @IsString()
  @Transform(trim)
  @Length(2, 160)
  @ApiPropertyOptional()
  nameAr?: string;
  @IsInt() @Min(1900) @Max(2200) @ApiProperty() declare deliveryYear: number;
}
export class PhaseUpdate extends PhaseInput {
  @IsInt() @Min(0) @ApiProperty() declare version: number;
}
export class BuildingInput extends SalesRequest {
  @IsString()
  @Transform(trim)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9_-]{1,49}$/)
  @ApiProperty()
  declare code: string;
  @IsString()
  @Transform(trim)
  @Length(2, 160)
  @ApiProperty()
  declare name: string;
  @IsOptional()
  @IsString()
  @Transform(trim)
  @Length(2, 160)
  @ApiPropertyOptional()
  nameAr?: string;
  @IsInt() @Min(0) @Max(300) @ApiProperty() declare floors: number;
}
export class BuildingUpdate extends BuildingInput {
  @IsInt() @Min(0) @ApiProperty() declare version: number;
}
export class UnitInput extends SalesRequest {
  @IsString()
  @Transform(trim)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9_-]{1,49}$/)
  @ApiProperty()
  declare code: string;
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ type: String, nullable: true })
  buildingId?: string | null;
  @IsIn(["primary", "resale", "rental"]) @ApiProperty() declare listing: string;
  @IsString()
  @Transform(trim)
  @Length(2, 200)
  @ApiProperty()
  declare location: string;
  @IsOptional()
  @IsString()
  @Transform(trim)
  @Length(2, 200)
  @ApiPropertyOptional()
  locationAr?: string;
  @IsIn(["apt", "villa", "office", "retail"])
  @ApiProperty()
  declare type: string;
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  @ApiPropertyOptional({ type: Number, nullable: true })
  bedrooms?: number | null;
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(9999999999.99)
  @ApiProperty()
  declare area: number;
  @IsString()
  @Transform(trim)
  @Length(0, 160)
  @ApiProperty()
  declare view: string;
  @IsOptional()
  @IsString()
  @Transform(trim)
  @Length(0, 160)
  @ApiPropertyOptional()
  viewAr?: string;
  @IsOptional()
  @IsInt()
  @Min(-20)
  @Max(300)
  @ApiPropertyOptional({ type: Number, nullable: true })
  floor?: number | null;
  @IsString()
  @Matches(/^(0|[1-9][0-9]{0,17})$/)
  @ApiProperty({ description: "Exact EGP minor units" })
  declare priceMinor: string;
}
export class UnitUpdate extends UnitInput {
  @IsInt() @Min(0) @ApiProperty() declare version: number;
}
export class InventoryArchive extends InventoryRevision {
  @IsIn(["archive", "restore"]) @ApiProperty() declare action: string;
}
