import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsDateString,
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
const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;
export const EVENT_TYPES = [
  "viewing",
  "call",
  "meeting",
  "inspection",
  "signing",
] as const;
export class EventQuery {
  @IsDateString() @ApiProperty() declare from: string;
  @IsDateString() @ApiProperty() declare to: string;
  @IsOptional()
  @IsIn(EVENT_TYPES)
  @ApiPropertyOptional({ enum: EVENT_TYPES })
  type?: string;
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ format: "uuid" })
  ownerId?: string;
}
export class EventInput extends SalesRequest {
  @IsIn(EVENT_TYPES) @ApiProperty({ enum: EVENT_TYPES }) declare type: string;
  @IsString()
  @Transform(trim)
  @MinLength(2)
  @MaxLength(200)
  @ApiProperty()
  declare title: string;
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MinLength(2)
  @MaxLength(200)
  @ApiPropertyOptional()
  titleAr?: string;
  @IsDateString() @ApiProperty() declare startsAt: string;
  @IsDateString() @ApiProperty() declare endsAt: string;
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(200)
  @ApiPropertyOptional()
  place?: string;
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ nullable: true })
  contactId?: string | null;
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ nullable: true })
  leadId?: string | null;
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ nullable: true })
  ownerId?: string | null;
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(2000)
  @ApiPropertyOptional()
  notes?: string;
}
export class EventUpdate extends EventInput {
  @IsInt() @Min(0) @ApiProperty() declare version: number;
}
export class EventStatus extends SalesRequest {
  @IsInt() @Min(0) @ApiProperty() declare version: number;
  @IsIn(["done", "canceled", "reopen"]) @ApiProperty() declare action: string;
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(1000)
  @ApiPropertyOptional()
  outcome?: string;
}
