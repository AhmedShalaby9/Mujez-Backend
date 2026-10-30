import {
  IsUUID,
  IsOptional,
  IsIn,
  IsString,
  IsInt,
  Min,
  Max,
  Length,
  Matches,
} from "class-validator";
import { Transform } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SalesQuery, SalesRequest } from "../../sales/leads/leads.dto.js";
export class ReservationQuery extends SalesQuery {
  @IsOptional()
  @IsIn(["hold", "reserved", "converted", "expired", "canceled"])
  @ApiPropertyOptional()
  status?: string;
  @IsOptional() @IsUUID() @ApiPropertyOptional() unitId?: string;
  @IsOptional() @IsUUID() @ApiPropertyOptional() leadId?: string;
}
export class HoldInput extends SalesRequest {
  @IsUUID() @ApiProperty() declare unitId: string;
  @IsUUID() @ApiProperty() declare leadId: string;
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ type: String, nullable: true })
  assigneeId?: string | null;
  @IsInt() @Min(0) @ApiProperty() declare unitVersion: number;
  @IsIn([24, 48, 72])
  @ApiProperty({ enum: [24, 48, 72] })
  declare hours: number;
}
export class ReservationAction extends SalesRequest {
  @IsInt() @Min(0) @ApiProperty() declare version: number;
  @IsIn(["confirm", "extend", "cancel"]) @ApiProperty() declare action: string;
  @IsOptional() @IsIn([24, 48, 72]) @ApiPropertyOptional() hours?: number;
  @IsOptional()
  @IsString()
  @Matches(/^(0|[1-9][0-9]{0,17})$/)
  @ApiPropertyOptional({
    description: "Manually recorded deposit; no external collection",
  })
  depositMinor?: string;
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @Length(10, 500)
  @ApiPropertyOptional()
  reason?: string;
}
