import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsString, Length, IsIn, IsOptional } from "class-validator";
import { trim } from "../support/support.dto.js";

export class EnterInput {
  @ApiProperty() @IsIn(["read", "manage"]) declare mode: "read" | "manage";
  @ApiProperty()
  @IsOptional()
  @IsString()
  @Transform(trim)
  @Length(10, 500)
  declare reason?: string;
  @ApiProperty()
  @IsOptional()
  @IsIn([30, 60, 120])
  declare durationMinutes?: number;
  @ApiProperty() @IsOptional() @IsString() declare password?: string;
}

export class ElevateInput {
  @ApiProperty()
  @IsString()
  @Transform(trim)
  @Length(10, 500)
  declare reason: string;
  @ApiProperty() @IsIn([30, 60, 120]) declare durationMinutes: number;
  @ApiProperty() @IsString() declare password: string;
}

export class ExitInput {
  @ApiProperty()
  @IsOptional()
  @IsString()
  @Transform(trim)
  @Length(0, 500)
  declare reason?: string;
}
