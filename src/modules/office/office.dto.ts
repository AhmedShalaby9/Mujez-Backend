import { IsObject, IsOptional, IsInt, Min } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SalesRequest } from "../sales/leads/leads.dto.js";
export class OfficeWrite extends SalesRequest {
  @IsObject()
  @ApiProperty({
    type: Object,
    description: "Validated office payload; see docs/office-workflow.md",
  })
  data!: Record<string, unknown>;
  @IsOptional() @IsInt() @Min(0) @ApiPropertyOptional() version?: number;
}
