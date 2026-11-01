import {
  IsString,
  IsOptional,
  IsUUID,
  IsIn,
  Length,
  Matches,
  IsInt,
  Min,
} from "class-validator";
import { Transform } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SalesQuery, SalesRequest } from "../../sales/leads/leads.dto.js";
export const DOCUMENT_KINDS = [
  "national_id",
  "ownership",
  "contract",
  "receipt",
  "power_of_attorney",
  "other",
];
export class DocumentQuery extends SalesQuery {
  @IsOptional()
  @IsIn(["expired", "expiring", "current", "pending", "verified", "rejected"])
  @ApiPropertyOptional()
  status?: string;
  @IsOptional() @IsIn(DOCUMENT_KINDS) @ApiPropertyOptional() kind?: string;
  @IsOptional() @IsUUID() @ApiPropertyOptional() leadId?: string;
  @IsOptional() @IsUUID() @ApiPropertyOptional() contractId?: string;
}
export class DocumentUpload extends SalesRequest {
  @IsIn(DOCUMENT_KINDS) @ApiProperty() declare kind: string;
  @IsString()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @Length(2, 200)
  @ApiProperty()
  declare title: string;
  @IsOptional() @IsUUID() @ApiPropertyOptional() leadId?: string;
  @IsOptional() @IsUUID() @ApiPropertyOptional() contractId?: string;
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @ApiPropertyOptional()
  expiresDate?: string;
}
export class DocumentArchive extends SalesRequest {
  @IsInt() @Min(0) @ApiProperty() declare version: number;
  @IsIn(["archive", "restore"]) @ApiProperty() declare action: string;
}

export class DocumentReview extends SalesRequest {
  @IsInt() @Min(0) @ApiProperty() version!: number;
  @IsIn(["verified", "rejected"]) @ApiProperty() status!: string;
  @IsString() @Length(5, 500) @ApiProperty() reason!: string;
}
