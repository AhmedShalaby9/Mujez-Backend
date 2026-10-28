import { Transform } from "class-transformer";
import {
  IsString,
  Matches,
  Length,
  IsIn,
  IsInt,
  Min,
  Max,
  IsBoolean,
  IsOptional,
  IsArray,
  ArrayMaxSize,
  ArrayUnique,
  IsUUID,
} from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
export class PlanInput {
  @ApiProperty()
  @IsString()
  @Length(2, 80)
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  declare nameEn: string;
  @ApiProperty()
  @IsString()
  @Length(2, 80)
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  declare nameAr: string;
  @ApiProperty() @IsString() @Length(0, 400) declare descEn: string;
  @ApiProperty() @IsString() @Length(0, 400) declare descAr: string;
  @ApiProperty()
  @IsInt()
  @Min(0)
  @Max(1000000000000)
  declare monthlyMinor: number;
  @ApiProperty()
  @IsInt()
  @Min(0)
  @Max(1000000000000)
  declare annualMinor: number;
  @ApiProperty() @IsOptional() @IsInt() @Min(0) @Max(1000000000) declare users:
    number | null;
  @ApiProperty()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000000000)
  declare listings: number | null;
  @ApiProperty()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000000000)
  declare projects: number | null;
  @ApiProperty()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000000000)
  declare storageGb: number | null;
  @ApiProperty() @IsString() @Length(0, 1000) declare featsEn: string;
  @ApiProperty() @IsString() @Length(0, 1000) declare featsAr: string;
}
export class PlanCreate extends PlanInput {
  @ApiProperty()
  @IsString()
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  @Length(2, 64)
  declare key: string;
}
export class Revision {
  @ApiProperty() @IsInt() @Min(0) declare version: number;
}
export class PlanEdit extends PlanInput {
  @ApiProperty() @IsInt() @Min(0) declare version: number;
  @ApiProperty() @IsIn(["new", "renewal", "migrate"]) declare scope: string;
  @ApiProperty()
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsString({ each: true })
  declare selectedIds: string[];
}
export class PlanArchive extends Revision {
  @ApiProperty() @IsBoolean() declare archived: boolean;
}
export class SubscriptionCreate {
  @ApiProperty() @IsString() @Length(3, 80) declare companyId: string;
  @ApiProperty()
  @IsString()
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  @Length(2, 64)
  declare plan: string;
  @ApiProperty() @IsIn(["monthly", "annual"]) declare cycle: string;
  @ApiProperty() @IsIn(["card", "bank", "instapay"]) declare payment: string;
  @ApiProperty() @IsIn(["trialing", "active"]) declare status: string;
  @ApiProperty() @IsUUID() declare planVersionId: string;
}
export class SubscriptionChange extends Revision {
  @ApiProperty()
  @IsString()
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  @Length(2, 64)
  declare plan: string;
  @ApiProperty() @IsUUID() declare planVersionId: string;
}
