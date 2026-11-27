import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Min,
  Max,
} from "class-validator";
import { Type } from "class-transformer";
import { SalesRequest } from "../leads/leads.dto.js";

export class DealDocumentInput {
  @IsIn(["eoi", "reservation", "contract", "id_copy", "other"]) kind!: string;
  @IsString() @Length(1, 180) fileName!: string;
  @IsString() @Length(1, 100) mimeType!: string;
  @IsString() data!: string;
}
export class DealInput extends SalesRequest {
  @IsUUID() @ApiProperty() leadId!: string;
  @IsOptional() @IsUUID() @ApiPropertyOptional() agentId?: string;
  @IsString() @Length(2, 200) @ApiProperty() clientName!: string;
  @Matches(/^\+[1-9][0-9]{7,14}$/) @ApiProperty() clientPhone!: string;
  @IsIn(["primary", "resale"]) @ApiProperty() sellingType!: string;
  @IsIn(["eoi", "reservation", "contracted", "cancelled"])
  @ApiProperty()
  status!: string;
  @IsUUID() @ApiProperty() developerId!: string;
  @IsUUID() @ApiProperty() projectId!: string;
  @Matches(/^[1-9]\d{0,14}$/)
  @ApiProperty({
    description:
      "Total unit sale price in EGP minor units; the basis for the developer claim and sales commissions",
  })
  unitValueMinor!: string;
  @IsObject() @ApiProperty() details!: Record<string, unknown>;
  @IsArray() @ApiProperty() documents!: DealDocumentInput[];
}
export class DealUpdate extends DealInput {
  @IsInt() @Min(0) @ApiProperty() version!: number;
  @IsOptional()
  @IsArray()
  @ApiPropertyOptional()
  declare documents: DealDocumentInput[];
}
export class DealDecision extends SalesRequest {
  @IsInt() @Min(0) @ApiProperty() version!: number;
  @IsIn(["approved", "rejected"]) @ApiProperty() decision!:
    "approved" | "rejected";
  @IsOptional()
  @IsString()
  @Length(3, 500)
  @ApiPropertyOptional()
  reason?: string;
}
export class DealListQuery {
  @IsOptional()
  @IsIn(["eoi", "reservation", "contracted", "cancelled"])
  status?: string;
  @IsOptional() @IsIn(["pending", "approved", "rejected"]) approval?: string;
  @IsOptional() @IsString() @Length(1, 100) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number =
    30;
}
export class DeveloperInput extends SalesRequest {
  @IsString() @Length(2, 160) @ApiProperty() name!: string;
}
export class DeveloperUpdate extends DeveloperInput {
  @IsInt() @Min(0) @ApiProperty() version!: number;
}
export class DeveloperArchive extends SalesRequest {
  @IsInt() @Min(0) @ApiProperty() version!: number;
}
export class BrokerageProjectInput extends SalesRequest {
  @IsUUID() @ApiProperty() developerId!: string;
  @IsString() @Length(2, 80) @ApiProperty() code!: string;
  @IsString() @Length(2, 160) @ApiProperty() name!: string;
  @IsString() @Length(2, 160) @ApiProperty() location!: string;
  @IsIn(["res", "com"]) @ApiProperty() segment!: "res" | "com";
}
