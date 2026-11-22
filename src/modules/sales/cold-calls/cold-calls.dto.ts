import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  Matches,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
} from "class-validator";
import { SalesRequest } from "../leads/leads.dto.js";
export const CALL_OUTCOMES = [
  "no_answer",
  "busy",
  "wrong_number",
  "not_interested",
  "interested",
  "callback",
] as const;
export class ColdQuery {
  @IsOptional() @IsIn(["mine", "all"]) @ApiPropertyOptional() view?: string;
  @IsOptional()
  @IsIn(["all", "due", "today", "upcoming", "scheduled"])
  @ApiPropertyOptional()
  callback?: string;
  @IsOptional() @IsUUID() @ApiPropertyOptional() ownerId?: string;
  @IsOptional() @IsIn(CALL_OUTCOMES) @ApiPropertyOptional() outcome?: string;
  @IsOptional() @IsString() @MaxLength(100) @ApiPropertyOptional() q?: string;
  @IsOptional()
  @IsIn(["pending", "open", "closed", "converted", "all"])
  @ApiPropertyOptional()
  status?: string;
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  @ApiPropertyOptional({ default: 1 })
  page = 1;
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @ApiPropertyOptional({ default: 50 })
  limit = 50;
}
export class ColdImport extends SalesRequest {
  @IsOptional() @IsUUID() @ApiPropertyOptional() ownerId?: string;
}
export class ColdPreview {
  @IsOptional() @IsUUID() @ApiPropertyOptional() ownerId?: string;
}
export class ColdConvert extends SalesRequest {
  @IsInt() @Min(0) @ApiProperty() version!: number;
  @IsIn(["res", "com"]) @ApiProperty() segment!: string;
  @IsString() @MinLength(1) @MaxLength(160) @ApiProperty() want!: string;
}

export class ColdVersion extends SalesRequest {
  @IsInt() @Min(0) @ApiProperty() version!: number;
}
export class ColdCallLog extends ColdVersion {
  @IsIn(CALL_OUTCOMES) @ApiProperty({ enum: CALL_OUTCOMES }) outcome!: string;
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @ApiPropertyOptional()
  notes?: string;
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  @ApiPropertyOptional({
    description:
      "Local date and time in Africa/Cairo; callback requires a date",
  })
  followUpAt?: string | null;
}
export class ColdNote extends ColdVersion {
  @IsString() @MinLength(1) @MaxLength(2000) @ApiProperty() notes!: string;
}
export class ColdFollowUp extends ColdVersion {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  @ApiPropertyOptional({
    nullable: true,
    description: "Cairo local time; null cancels the appointment",
  })
  followUpAt?: string | null;
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @ApiPropertyOptional()
  notes?: string;
}
export class ColdAssignItem {
  @IsUUID() @ApiProperty() id!: string;
  @IsInt() @Min(0) @ApiProperty() version!: number;
}
export class ColdAssignment extends SalesRequest {
  @IsUUID() @ApiProperty() ownerId!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ColdAssignItem)
  @ApiProperty({ type: [ColdAssignItem], maxItems: 100 })
  items!: ColdAssignItem[];
}
