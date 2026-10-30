import { IsIn, IsOptional } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SalesRequest } from "../../sales/leads/leads.dto.js";
export class ReportQuery {
  @IsOptional()
  @IsIn(["month", "quarter", "ytd"])
  @ApiPropertyOptional({ default: "quarter" })
  period = "quarter";
  @IsOptional() @IsIn(["res", "com"]) @ApiPropertyOptional() segment?: string;
}
export class ReportExport extends SalesRequest {
  @IsIn(["month", "quarter", "ytd"]) @ApiProperty() declare period: string;
  @IsOptional() @IsIn(["res", "com"]) @ApiPropertyOptional() segment?: string;
  @IsOptional() @IsIn(["en", "ar"]) @ApiPropertyOptional() lang = "en";
}
export class OverviewQuery {
  @IsOptional() @IsIn(["res", "com"]) @ApiPropertyOptional() segment?: string;
}
