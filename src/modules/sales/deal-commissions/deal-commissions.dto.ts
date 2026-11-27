import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { SalesRequest } from "../leads/leads.dto.js";

export class CommissionEntryInput {
  @IsUUID() @ApiProperty() userId!: string;
  @Matches(/^[1-9]\d{0,14}$/)
  @ApiProperty({ description: "Commission amount in EGP minor units" })
  amountMinor!: string;
  @IsOptional()
  @IsString()
  @Length(0, 300)
  @ApiPropertyOptional()
  note?: string;
}
export class DealCommissionInput extends SalesRequest {
  @IsUUID() @ApiProperty() dealId!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => CommissionEntryInput)
  @ApiProperty({ type: [CommissionEntryInput] })
  entries!: CommissionEntryInput[];
}
export class DealCommissionQuery {
  @IsOptional() @IsUUID() dealId?: string;
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number =
    30;
}
