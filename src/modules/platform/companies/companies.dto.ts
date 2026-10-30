import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  IsEmail,
  IsIn,
  IsInt,
  IsString,
  Length,
  MaxLength,
  Min,
  IsBoolean,
  IsOptional,
  Matches,
} from "class-validator";
export class CompanyInput {
  @IsString()
  @Length(2, 160)
  @ApiProperty()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  declare nameEn: string;
  @IsString()
  @Length(2, 160)
  @ApiProperty()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  declare nameAr: string;
  @IsString()
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  @Length(2, 80)
  @ApiProperty()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  declare slug: string;
  @IsIn(["brokerage", "developer", "property_mgmt", "hybrid"])
  @ApiProperty()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  declare type: string;
  @IsString()
  @Length(1, 100)
  @ApiProperty()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  declare city: string;
  @IsEmail()
  @MaxLength(254)
  @ApiProperty()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  declare adminEmail: string;
  @IsString()
  @MaxLength(40)
  @ApiProperty()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  declare phone: string;
  @IsString()
  @MaxLength(250)
  @Matches(/^(https?:\/\/[^\s]+|[^\s:/]+\.[^\s/]+|)$/)
  @ApiProperty()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  declare website: string;
  @IsIn(["starter", "pro", "business", "enterprise"])
  @ApiProperty()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  declare plan: string;
}
export class CompanyUpdate extends CompanyInput {
  @IsInt() @Min(0) @ApiProperty() declare version: number;
}
export class StatusInput {
  @IsIn(["suspend", "reactivate", "archive", "activate"])
  @ApiProperty()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  declare action: string;
  @IsInt() @Min(0) @ApiProperty() declare version: number;
  @IsString()
  @Length(10, 500)
  @ApiProperty()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  declare reason: string;
}
export class StepInput {
  @IsIn(["admin_contact", "inventory", "team", "lead_sources", "first_deal"])
  @ApiProperty()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  declare step: string;
  @IsBoolean() @ApiProperty() declare completed: boolean;
  @IsInt() @Min(0) @ApiProperty() declare version: number;
}
