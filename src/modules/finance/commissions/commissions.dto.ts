import {
  IsInt,
  Min,
  Max,
  IsOptional,
  IsUUID,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
  IsIn,
  IsString,
  Length,
  Matches,
} from "class-validator";
import { Type, Transform } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SalesQuery, SalesRequest } from "../../sales/leads/leads.dto.js";
export class CommissionSplit {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ type: String, nullable: true })
  payeeId?: string | null;
  @IsInt() @Min(1) @Max(10000) @ApiProperty() declare shareBps: number;
}
export class CommissionInput extends SalesRequest {
  @IsUUID() @ApiProperty() declare contractId: string;
  @IsInt() @Min(0) @ApiProperty() declare contractVersion: number;
  @IsInt() @Min(1) @Max(10000) @ApiProperty() declare rateBps: number;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CommissionSplit)
  @ApiProperty({ type: [CommissionSplit] })
  declare splits: CommissionSplit[];
}
export class CommissionUpdate extends CommissionInput {
  @IsInt() @Min(0) @ApiProperty() declare version: number;
}
export class CommissionQuery extends SalesQuery {
  @IsOptional()
  @IsIn(["calculated", "approved", "payable", "paid", "canceled"])
  @ApiPropertyOptional()
  status?: string;
}
export class CommissionAction extends SalesRequest {
  @IsInt() @Min(0) @ApiProperty() declare version: number;
  @IsIn(["approve", "mark_payable", "record_paid", "cancel"])
  @ApiProperty()
  declare action: string;
  @IsString()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @Length(10, 500)
  @ApiProperty()
  declare reason: string;
  @IsOptional() @IsUUID() @ApiPropertyOptional() documentId?: string;
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @Length(3, 200)
  @ApiPropertyOptional()
  reference?: string;
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @ApiPropertyOptional()
  paidDate?: string;
}
