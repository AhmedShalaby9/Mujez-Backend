import {
  IsString,
  IsOptional,
  IsUUID,
  IsIn,
  IsInt,
  Min,
  Max,
  Length,
  Matches,
  IsArray,
  ArrayMaxSize,
  ValidateNested,
  IsBoolean,
} from "class-validator";
import { Transform, Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SalesRequest } from "../../sales/leads/leads.dto.js";
import { CAMPAIGN_SOURCES } from "../../growth/marketing/marketing.dto.js";
const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;
export class RoutingTarget {
  @IsUUID() @ApiProperty() declare userId: string;
  @IsInt() @Min(1) @Max(1000) @ApiProperty() weight = 1;
}
export class RoutingInput extends SalesRequest {
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
  @IsOptional() @IsIn(CAMPAIGN_SOURCES) @ApiPropertyOptional() source?:
    string | null;
  @IsOptional() @IsIn(["res", "com"]) @ApiPropertyOptional() segment?:
    string | null;
  @IsOptional()
  @Matches(/^(0|[1-9][0-9]{0,17})$/)
  @ApiPropertyOptional()
  minBudgetMinor?: string | null;
  @IsIn(["round_robin", "weighted", "specific_user", "team"])
  @ApiProperty()
  declare strategy: string;
  @IsOptional()
  @IsString()
  @Transform(trim)
  @Length(2, 160)
  @ApiPropertyOptional()
  teamName?: string;
  @IsOptional()
  @IsString()
  @Transform(trim)
  @Length(2, 160)
  @ApiPropertyOptional()
  teamNameAr?: string;
  @IsInt() @Min(0) @Max(1440) @ApiProperty() declare slaMinutes: number;
  @IsBoolean() @ApiProperty() declare active: boolean;
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => RoutingTarget)
  @ApiProperty({ type: [RoutingTarget] })
  declare targets: RoutingTarget[];
}
export class RoutingUpdate extends RoutingInput {
  @IsInt() @Min(0) @ApiProperty() declare version: number;
}
export class RoutingAction extends SalesRequest {
  @IsInt() @Min(0) @ApiProperty() declare version: number;
  @IsIn(["enable", "disable", "up", "down", "archive", "restore"])
  @ApiProperty()
  declare action: string;
}
export class RoutingSimulation {
  @IsOptional() @IsUUID() @ApiPropertyOptional() requestId?: string;
  @IsIn(CAMPAIGN_SOURCES) @ApiProperty() declare source: string;
  @IsIn(["res", "com"]) @ApiProperty() declare segment: string;
  @IsOptional()
  @Matches(/^(0|[1-9][0-9]{0,17})$/)
  @ApiPropertyOptional()
  budgetMinor?: string | null;
}
