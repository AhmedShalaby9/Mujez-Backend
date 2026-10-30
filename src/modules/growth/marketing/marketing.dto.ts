import {
  IsString,
  IsOptional,
  IsUUID,
  IsIn,
  IsInt,
  Min,
  Length,
  Matches,
} from "class-validator";
import { Transform } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SalesQuery, SalesRequest } from "../../sales/leads/leads.dto.js";
export const CAMPAIGN_SOURCES = [
  "manual",
  "referral",
  "website",
  "phone",
  "walk_in",
  "social",
  "other",
];
export class CampaignInput extends SalesRequest {
  @IsString()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @Length(2, 160)
  @ApiProperty()
  declare name: string;
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @Length(2, 160)
  @ApiPropertyOptional()
  nameAr?: string;
  @IsIn(CAMPAIGN_SOURCES) @ApiProperty() declare source: string;
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ type: String, nullable: true })
  projectId?: string | null;
  @IsIn(["draft", "active", "ended"]) @ApiProperty() declare status: string;
  @IsString()
  @Matches(/^(0|[1-9][0-9]{0,17})$/)
  @ApiProperty()
  declare spendMinor: string;
}
export class CampaignUpdate extends CampaignInput {
  @IsInt() @Min(0) @ApiProperty() declare version: number;
}
export class CampaignQuery extends SalesQuery {
  @IsOptional()
  @IsIn(["draft", "active", "ended"])
  @ApiPropertyOptional()
  status?: string;
}
export class CampaignArchive extends SalesRequest {
  @IsInt() @Min(0) @ApiProperty() declare version: number;
  @IsIn(["archive", "restore"]) @ApiProperty() declare action: string;
}
