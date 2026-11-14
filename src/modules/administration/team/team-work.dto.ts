import { ApiProperty, ApiPropertyOptional, PickType } from "@nestjs/swagger";
import { Type, Transform } from "class-transformer";
import {
  IsOptional,
  IsUUID,
  IsString,
  MaxLength,
  IsInt,
  Min,
  Max,
  IsIn,
} from "class-validator";
import { SalesRequest, STAGES } from "../../sales/leads/leads.dto.js";
export class TeamWorkQuery {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ format: "uuid" })
  memberId?: string;
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @ApiPropertyOptional()
  q?: string;
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
  @ApiPropertyOptional({ default: 25 })
  limit = 25;
}
export class TeamLeadQuery extends TeamWorkQuery {
  @IsOptional()
  @IsIn(STAGES)
  @ApiPropertyOptional({ enum: STAGES })
  stage?: string;
}
export class TeamTaskQuery extends TeamWorkQuery {
  @IsOptional()
  @IsIn(["open", "done", "cancelled"])
  @ApiPropertyOptional({ enum: ["open", "done", "cancelled"] })
  status?: string;
}
export class TeamPerformanceQuery {
  @IsOptional()
  @Type(() => Number)
  @IsIn([7, 30, 90])
  @ApiPropertyOptional({ enum: [7, 30, 90], default: 30 })
  days = 30;
}
export class TeamLeadAssignment extends SalesRequest {
  @IsUUID() @ApiProperty({ format: "uuid" }) declare ownerId: string;
  @IsInt() @Min(0) @ApiProperty({ minimum: 0 }) declare version: number;
}

import { TaskInput } from "../../sales/tasks/tasks.dto.js";
export class TeamTaskCreate extends PickType(TaskInput, [
  "requestId",
  "title",
  "titleAr",
  "description",
  "leadId",
  "dueDate",
  "priority",
] as const) {
  @IsUUID() @ApiProperty({ format: "uuid" }) declare assigneeId: string;
}
export class TeamTaskAssignment extends SalesRequest {
  @IsUUID() @ApiProperty({ format: "uuid" }) declare assigneeId: string;
  @IsInt() @Min(0) @ApiProperty({ minimum: 0 }) declare version: number;
}
