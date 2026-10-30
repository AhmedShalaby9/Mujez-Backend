import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { SalesRequest } from "../leads/leads.dto.js";
const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;
export const TASK_GROUPS = [
  "overdue",
  "today",
  "tomorrow",
  "week",
  "later",
] as const;
export class TaskQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  @ApiPropertyOptional({ default: 1 })
  page = 1;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @ApiPropertyOptional({ default: 50 })
  limit = 50;
  @IsOptional()
  @IsIn(["open", "done", "cancelled", "all"])
  @ApiPropertyOptional({ enum: ["open", "done", "cancelled", "all"] })
  status?: string;
  @IsOptional()
  @IsIn(TASK_GROUPS)
  @ApiPropertyOptional({ enum: TASK_GROUPS })
  group?: string;
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(100)
  @ApiPropertyOptional()
  q?: string;
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ format: "uuid" })
  leadId?: string;
  @IsOptional()
  @Matches(
    /^(unassigned|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
  )
  @ApiPropertyOptional()
  assigneeId?: string;
}
export class TaskInput extends SalesRequest {
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
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(2000)
  @ApiPropertyOptional()
  description?: string;
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ type: String, format: "uuid", nullable: true })
  leadId?: string | null;
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ type: String, format: "uuid", nullable: true })
  assigneeId?: string | null;
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @ApiPropertyOptional({
    type: String,
    format: "date",
    description:
      "Africa/Cairo calendar date; defaults to server today on creation",
  })
  dueDate?: string;
  @IsIn(["high", "med", "low"])
  @ApiProperty({ enum: ["high", "med", "low"] })
  declare priority: string;
}
export class TaskUpdate extends TaskInput {
  @IsInt() @Min(0) @ApiProperty() declare version: number;
}
export class TaskStatus extends SalesRequest {
  @IsInt() @Min(0) @ApiProperty() declare version: number;
  @IsIn(["complete", "reopen", "cancel"])
  @ApiProperty({ enum: ["complete", "reopen", "cancel"] })
  declare action: string;
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MinLength(10)
  @MaxLength(500)
  @ApiPropertyOptional()
  reason?: string;
}
