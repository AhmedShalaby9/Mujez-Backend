import { Transform } from "class-transformer";
import {
  IsString,
  Length,
  IsInt,
  Min,
  Max,
  IsBoolean,
  IsIn,
  IsDateString,
  IsOptional,
} from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
export class PolicyVersion {
  @ApiProperty() @IsInt() @Min(0) declare version: number;
}
export class FeatureChange extends PolicyVersion {
  @ApiProperty() @IsIn(["flag", "rollout", "plan"]) declare action: string;
  @ApiProperty() @IsOptional() @IsBoolean() declare enabled?: boolean;
  @ApiProperty()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  declare rollout?: number;
  @ApiProperty() @IsOptional() @IsString() @Length(2, 64) declare plan?: string;
  @ApiProperty()
  @IsString()
  @Length(5, 500)
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  declare reason: string;
}
export class FeatureOverride extends PolicyVersion {
  @ApiProperty() @IsString() @Length(3, 80) declare companyId: string;
  @ApiProperty() @IsString() @Length(2, 80) declare featureKey: string;
  @ApiProperty() @IsBoolean() declare enabled: boolean;
  @ApiProperty() @IsDateString({ strict: true }) declare expiresAt: string;
  @ApiProperty()
  @IsString()
  @Length(5, 500)
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  declare reason: string;
}
export class ReasonVersion extends PolicyVersion {
  @ApiProperty()
  @IsString()
  @Length(5, 500)
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  declare reason: string;
}
export class LimitOverride extends ReasonVersion {
  @ApiProperty()
  @IsIn(["users", "listings", "storage"])
  declare resource: string;
}
