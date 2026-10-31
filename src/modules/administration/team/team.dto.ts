import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";
const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;
export const TEAM_ROLES = ["agent"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];
export class TeamInvite {
  @IsString()
  @Transform(trim)
  @MinLength(2)
  @MaxLength(120)
  declare name: string;
  @IsEmail()
  @Transform(trim)
  @MaxLength(254)
  declare email: string;
  @IsIn(TEAM_ROLES)
  @ApiProperty({ type: String, enum: TEAM_ROLES })
  declare role: TeamRole;
}
export class TeamStatus {
  @IsIn(["disable", "enable"])
  @ApiProperty({ type: String, enum: ["disable", "enable"] })
  declare action: "disable" | "enable";
}
export class TeamActivate {
  @IsString() @Matches(/^[a-f0-9]{64}$/) declare token: string;
  @IsString() @MinLength(12) @MaxLength(256) declare password: string;
}
export class TeamQuery {
  @IsOptional()
  @IsIn(["all", "invited", "active", "disabled"])
  @ApiPropertyOptional({ type: String })
  status?: string;
}
