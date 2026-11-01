import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  IsString,
  Length,
  IsEmail,
  IsUUID,
  IsOptional,
  IsIn,
  Matches,
  IsInt,
  Min,
} from "class-validator";
const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;
export class DemoRequestInput {
  @ApiProperty() @IsUUID("4") requestId!: string;
  @ApiProperty() @IsString() @Transform(trim) @Length(2, 120) fullName!: string;
  @ApiProperty()
  @IsString()
  @Transform(trim)
  @Length(2, 160)
  companyName!: string;
  @ApiProperty()
  @IsEmail()
  @Length(3, 254)
  @Transform(({ value }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  email!: string;
  @ApiProperty()
  @IsString()
  @Transform(trim)
  @Length(8, 40)
  @Matches(/^\+?[0-9 ()-]+$/)
  phone!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(/^[a-z][a-z0-9_-]{1,79}$/)
  plan?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(["monthly", "annual"])
  cycle?: string;
}
export class DemoRequestStatus {
  @ApiProperty() @IsInt() @Min(0) version!: number;
  @ApiProperty() @IsIn(["new", "contacted", "closed"]) status!: string;
}
