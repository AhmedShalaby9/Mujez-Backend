import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  IsString,
  Length,
  IsInt,
  Min,
  IsIn,
  IsBoolean,
  IsEmail,
} from "class-validator";
const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;
export class AdminAuth {
  @ApiProperty() @IsString() @Length(1, 256) declare password: string;
  @ApiProperty()
  @IsString()
  @Transform(trim)
  @Length(5, 500)
  declare reason: string;
}
export class AdminVersion extends AdminAuth {
  @ApiProperty() @IsInt() @Min(0) declare version: number;
}
export class InviteAdmin extends AdminAuth {
  @ApiProperty()
  @IsString()
  @Transform(trim)
  @Length(2, 100)
  declare name: string;
  @ApiProperty()
  @IsEmail()
  @Length(3, 254)
  @Transform(({ value }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  declare email: string;
  @ApiProperty() @IsString() @Length(2, 80) declare role: string;
}
export class AssignRole extends AdminVersion {
  @ApiProperty() @IsString() @Length(2, 80) declare role: string;
}
export class UserStatus extends AdminVersion {
  @ApiProperty() @IsIn(["active", "disabled"]) declare status: string;
}
export class NewRole extends AdminAuth {
  @ApiProperty()
  @IsString()
  @Transform(trim)
  @Length(2, 80)
  declare nameEn: string;
  @ApiProperty()
  @IsString()
  @Transform(trim)
  @Length(2, 80)
  declare nameAr: string;
}
export class PermissionChange extends AdminVersion {
  @ApiProperty() @IsString() @Length(2, 40) declare permission: string;
  @ApiProperty() @IsBoolean() declare enabled: boolean;
}
export class ActivateAdmin {
  @ApiProperty() @IsString() @Length(64, 64) declare token: string;
  @ApiProperty() @IsString() @Length(12, 256) declare password: string;
}
