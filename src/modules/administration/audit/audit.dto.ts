import {
  IsOptional,
  IsString,
  MaxLength,
  Matches,
  IsInt,
  Min,
  Max,
} from "class-validator";
import { Type, Transform } from "class-transformer";
import { ApiPropertyOptional } from "@nestjs/swagger";
export class CompanyAuditQuery {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @ApiPropertyOptional()
  q?: string;
  @IsOptional()
  @Matches(
    /^(system|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
  )
  @ApiPropertyOptional()
  actor?: string;
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @ApiPropertyOptional()
  action?: string;
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @ApiPropertyOptional()
  from?: string;
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @ApiPropertyOptional()
  to?: string;
  @IsOptional()
  @IsString()
  @MaxLength(300)
  @ApiPropertyOptional()
  cursor?: string;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @ApiPropertyOptional({ default: 50 })
  limit = 50;
}
