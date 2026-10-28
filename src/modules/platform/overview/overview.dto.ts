import { ApiProperty } from "@nestjs/swagger";
import { IsOptional, IsIn, IsString, Matches } from "class-validator";
export class OverviewQuery {
  @ApiProperty({ required: false, enum: ["30d", "90d", "12m", "custom"] })
  @IsOptional()
  @IsIn(["30d", "90d", "12m", "custom"])
  declare range?: "30d" | "90d" | "12m" | "custom";
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  declare from?: string;
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  declare to?: string;
}
