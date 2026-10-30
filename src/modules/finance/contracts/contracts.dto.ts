import {
  IsString,
  IsOptional,
  IsUUID,
  IsIn,
  Length,
  Matches,
  IsInt,
  Min,
  Max,
  IsArray,
  ArrayMaxSize,
  ArrayMinSize,
  ValidateNested,
  IsBoolean,
} from "class-validator";
import { Transform, Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SalesQuery, SalesRequest } from "../../sales/leads/leads.dto.js";
import { DOCUMENT_KINDS } from "../documents/documents.dto.js";
const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;
export const CONTRACT_TYPES = [
  "sale",
  "reservation",
  "lease",
  "listing",
  "broker_agreement",
];
export class SignerInput {
  @IsString()
  @Transform(trim)
  @Length(2, 120)
  @ApiProperty()
  declare name: string;
  @IsOptional()
  @IsString()
  @Transform(trim)
  @Length(2, 120)
  @ApiPropertyOptional()
  nameAr?: string;
  @IsString()
  @Transform(trim)
  @Length(2, 100)
  @ApiProperty()
  declare role: string;
  @IsOptional()
  @IsString()
  @Transform(trim)
  @Length(2, 100)
  @ApiPropertyOptional()
  roleAr?: string;
}
export class RequirementInput {
  @IsIn(DOCUMENT_KINDS) @ApiProperty() declare kind: string;
  @IsString()
  @Transform(trim)
  @Length(2, 160)
  @ApiProperty()
  declare label: string;
  @IsBoolean() @ApiProperty() declare required: boolean;
}
export class ContractFields extends SalesRequest {
  @IsString()
  @Transform(trim)
  @Length(2, 200)
  @ApiProperty()
  declare title: string;
  @IsOptional()
  @IsString()
  @Transform(trim)
  @Length(2, 200)
  @ApiPropertyOptional()
  titleAr?: string;
  @IsString()
  @Matches(/^(0|[1-9][0-9]{0,17})$/)
  @ApiProperty()
  declare valueMinor: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) @ApiProperty() declare keyDate: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => SignerInput)
  @ApiProperty({ type: [SignerInput] })
  declare signers: SignerInput[];
}
export class ContractInput extends ContractFields {
  @IsIn(CONTRACT_TYPES) @ApiProperty() declare type: string;
  @IsUUID() @ApiProperty() declare leadId: string;
  @IsOptional() @IsUUID() @ApiPropertyOptional() unitId?: string;
  @IsOptional() @IsUUID() @ApiPropertyOptional() reservationId?: string;
  @IsOptional()
  @IsInt()
  @Min(0)
  @ApiPropertyOptional()
  reservationVersion?: number;
  @IsOptional() @IsInt() @Min(0) @ApiPropertyOptional() unitVersion?: number;
  @IsOptional() @IsUUID() @ApiPropertyOptional() ownerId?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => RequirementInput)
  @ApiPropertyOptional({ type: [RequirementInput] })
  requirements?: RequirementInput[];
}
export class ContractUpdate extends ContractFields {
  @IsInt() @Min(0) @ApiProperty() declare version: number;
}
export class ContractQuery extends SalesQuery {
  @IsOptional()
  @IsIn(["draft", "sent", "signed", "expiring", "void"])
  @ApiPropertyOptional()
  status?: string;
  @IsOptional() @IsIn(CONTRACT_TYPES) @ApiPropertyOptional() type?: string;
  @IsOptional() @IsUUID() @ApiPropertyOptional() leadId?: string;
}
export class ContractAction extends SalesRequest {
  @IsInt() @Min(0) @ApiProperty() declare version: number;
  @IsIn(["record_shared", "record_signed", "void"])
  @ApiProperty()
  declare action: string;
  @IsString()
  @Transform(trim)
  @Length(10, 500)
  @ApiProperty()
  declare reason: string;
  @IsOptional()
  @IsString()
  @Transform(trim)
  @Length(3, 200)
  @ApiPropertyOptional()
  reference?: string;
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @ApiPropertyOptional()
  signedDate?: string;
  @IsOptional() @IsUUID() @ApiPropertyOptional() documentId?: string;
}
export class RequirementAttach extends SalesRequest {
  @IsInt() @Min(0) @ApiProperty() declare version: number;
  @IsUUID() @ApiProperty() declare documentId: string;
}
