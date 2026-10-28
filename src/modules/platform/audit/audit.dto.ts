import { ApiProperty } from "@nestjs/swagger";
import { Type, Transform } from "class-transformer";
import {
  IsOptional,
  IsString,
  Length,
  IsInt,
  Min,
  Max,
  IsIn,
  IsDateString,
  ValidateNested,
} from "class-validator";
import { AdminAuth } from "../roles/access.dto.js";
export class AuditQuery {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(0, 200)
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  declare q?: string;
  @ApiProperty({ required: false })
  @IsOptional()
  @IsIn(["all", "ws", "low", "med", "high"])
  declare filter?: string;
  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  declare limit?: number;
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(0, 300)
  declare cursor?: string;
  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString({ strict: true })
  declare from?: string;
  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString({ strict: true })
  declare until?: string;
}
export class AuditExport extends AdminAuth {
  @ApiProperty({ type: AuditQuery })
  @ValidateNested()
  @Type(() => AuditQuery)
  declare filters: AuditQuery;
}
