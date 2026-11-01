import { ApiProperty, PartialType } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
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
  ValidateNested,
  IsUUID,
  IsISO31661Alpha2,
} from "class-validator";
export class OwnerProfileInput {
  @IsString() @Length(2, 160) name!: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(100) title?: string;
  @IsOptional() @IsIn(["ar", "en"]) lang?: string;
}
export class CompanyInput {
  @IsOptional() @IsUUID() planVersionId?: string;
  @IsOptional() @IsISO31661Alpha2() country?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsEmail() @MaxLength(254) companyEmail?: string;
  @IsOptional() @IsString() @MaxLength(80) taxNumber?: string;
  @IsOptional() @IsString() @MaxLength(80) crNumber?: string;
  @IsOptional()
  @ValidateNested()
  @Type(() => OwnerProfileInput)
  owner?: OwnerProfileInput;
  @IsOptional() @IsIn(["monthly", "annual"]) cycle?: string;
  @IsOptional() @IsIn(["card", "bank", "instapay"]) paymentMethod?: string;
  @IsOptional() @IsUUID() draftId?: string;
  @IsOptional() @IsInt() @Min(0) draftVersion?: number;
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
export class CompanyDraftInput extends PartialType(CompanyInput) {
  @IsOptional() @IsInt() @Min(0) version?: number;
}
export class ManagerInput {
  @IsInt() @Min(0) version!: number;
  @IsOptional() @IsUUID() managerId?: string | null;
}
export class StatusInput {
  @IsOptional()
  @IsIn(["non_payment", "security", "terms", "customer_request", "other"])
  reasonCode?: string;
  @IsOptional() @IsBoolean() acknowledged?: boolean;
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

export class CompanyQuoteInput {
  @IsIn(["starter", "pro", "business", "enterprise"]) plan!: string;
  @IsIn(["monthly", "annual"]) cycle!: string;
}
