import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
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
export class ColdQuery {
  @IsOptional() @IsString() @MaxLength(100) @ApiPropertyOptional() q?: string;
  @IsOptional()
  @IsIn(["pending", "converted", "all"])
  @ApiPropertyOptional()
  status?: string;
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  @ApiPropertyOptional({ default: 1 })
  page = 1;
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @ApiPropertyOptional({ default: 50 })
  limit = 50;
}
export class ColdImport extends SalesRequest {
  @IsOptional() @IsUUID() @ApiPropertyOptional() ownerId?: string;
}
export class ColdPreview {
  @IsOptional() @IsUUID() @ApiPropertyOptional() ownerId?: string;
}
export class ColdConvert extends SalesRequest {
  @IsInt() @Min(0) @ApiProperty() version!: number;
  @IsIn(["res", "com"]) @ApiProperty() segment!: string;
  @IsString() @MinLength(1) @MaxLength(160) @ApiProperty() want!: string;
}
