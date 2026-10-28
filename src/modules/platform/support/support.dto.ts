import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  IsString,
  Length,
  IsIn,
  IsInt,
  Min,
  IsOptional,
  IsUUID,
} from "class-validator";
export const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;
export class Version {
  @ApiProperty() @IsInt() @Min(0) declare version: number;
}
export class TicketInput {
  @ApiProperty() @IsString() @Length(3, 80) declare companyId: string;
  @ApiProperty()
  @IsString()
  @Transform(trim)
  @Length(3, 160)
  declare subjectEn: string;
  @ApiProperty()
  @IsString()
  @Transform(trim)
  @Length(3, 160)
  declare subjectAr: string;
  @ApiProperty()
  @IsIn(["tech", "billing", "subscription", "integration", "feature", "access"])
  declare category: string;
  @ApiProperty()
  @IsIn(["urgent", "high", "med", "low"])
  declare priority: string;
  @ApiProperty()
  @IsString()
  @Transform(trim)
  @Length(2, 160)
  declare requester: string;
  @ApiProperty()
  @IsString()
  @Transform(trim)
  @Length(2, 5000)
  declare message: string;
}
export class TicketChange extends Version {
  @ApiProperty() @IsIn(["status", "assign", "priority"]) declare action: string;
  @ApiProperty()
  @IsOptional()
  @IsIn(["open", "progress", "waiting", "resolved", "closed"])
  declare status?: string;
  @ApiProperty() @IsOptional() @IsUUID() declare assignedTo?: string | null;
  @ApiProperty()
  @IsOptional()
  @IsIn(["urgent", "high", "med", "low"])
  declare priority?: string;
}
export class EntryInput extends Version {
  @ApiProperty() @IsIn(["reply", "internal"]) declare kind:
    "reply" | "internal";
  @ApiProperty()
  @IsString()
  @Transform(trim)
  @Length(2, 5000)
  declare text: string;
}
export class WorkspaceInput extends Version {
  @ApiProperty()
  @IsString()
  @Transform(trim)
  @Length(10, 500)
  declare reason: string;
  @ApiProperty() @IsIn([30, 60, 120]) declare durationMinutes: number;
}
