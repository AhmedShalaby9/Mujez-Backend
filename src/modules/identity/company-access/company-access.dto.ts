import {
  IsInt,
  Min,
  IsString,
  MinLength,
  MaxLength,
  Matches,
} from "class-validator";
import { Transform } from "class-transformer";
export class OwnerInvite {
  @IsInt() @Min(0) declare version: number;
  @IsString()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @MinLength(2)
  @MaxLength(120)
  declare name: string;
  @IsString() @MinLength(1) @MaxLength(256) declare password: string;
  @IsString() @MinLength(10) @MaxLength(500) declare reason: string;
}
export class OwnerRevoke {
  @IsInt() @Min(0) declare version: number;
  @IsString() @MinLength(1) @MaxLength(256) declare password: string;
  @IsString() @MinLength(10) @MaxLength(500) declare reason: string;
}
export class OwnerActivate {
  @IsString() @Matches(/^[a-f0-9]{64}$/) declare token: string;
  @IsString() @MinLength(12) @MaxLength(256) declare password: string;
}
