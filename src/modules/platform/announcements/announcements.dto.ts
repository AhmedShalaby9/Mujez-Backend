import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  IsString,
  Length,
  IsIn,
  IsOptional,
  IsDateString,
  IsBoolean,
  Matches,
} from "class-validator";
import { Version, trim } from "../support/support.dto.js";
export class AnnouncementInput extends Version {
  @ApiProperty()
  @IsString()
  @Transform(trim)
  @Length(0, 120)
  declare titleEn: string;
  @ApiProperty()
  @IsString()
  @Transform(trim)
  @Length(0, 120)
  declare titleAr: string;
  @ApiProperty()
  @IsString()
  @Transform(trim)
  @Length(0, 280)
  declare bodyEn: string;
  @ApiProperty()
  @IsString()
  @Transform(trim)
  @Length(0, 280)
  declare bodyAr: string;
  @ApiProperty()
  @IsIn(["maint", "feature", "update", "billing"])
  declare type: string;
  @ApiProperty()
  @IsIn(["all", "starter", "pro", "business", "enterprise"])
  declare target: string;
  @ApiProperty() @IsIn(["both", "en", "ar"]) declare lang: string;
  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  declare from?: string | null;
  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  declare to?: string | null;
  @ApiProperty() @IsBoolean() declare published: boolean;
}
