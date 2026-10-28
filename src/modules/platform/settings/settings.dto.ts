import { ApiProperty } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsString,
  Length,
  IsIn,
  IsInt,
  Min,
  Max,
  IsBoolean,
  Matches,
  ValidateNested,
  IsNumber,
} from "class-validator";
import { AdminVersion } from "../roles/access.dto.js";
const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;
export class SettingsValue {
  @ApiProperty()
  @IsString()
  @Transform(trim)
  @Length(2, 80)
  declare platformName: string;
  @ApiProperty()
  @IsString()
  @Length(0, 254)
  @Matches(/^(?:[^\s@]+@[^\s@]+\.[^\s@]+)?$/)
  declare supportEmail: string;
  @ApiProperty() @IsIn(["en", "ar"]) declare defaultLang: string;
  @ApiProperty() @IsIn(["Africa/Cairo"]) declare defaultTimezone: string;
  @ApiProperty() @IsInt() @Min(1) @Max(90) declare trialDays: number;
  @ApiProperty()
  @IsIn(["starter", "pro", "business", "enterprise"])
  declare defaultPlan: string;
  @ApiProperty() @IsIn(["EGP"]) declare defaultCurrency: string;
  @ApiProperty() @IsIn(["INV-{UUID}"]) declare invoiceFormat: string;
  @ApiProperty() @IsInt() @Min(0) @Max(180) declare paymentTerms: number;
  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  declare taxRate: number;
  @ApiProperty() @IsIn(["manual"]) declare taxProfile: string;
  @ApiProperty() @IsBoolean() declare requireMfa: boolean;
  @ApiProperty() @IsInt() @Min(15) @Max(1440) declare sessionLength: number;
  @ApiProperty() @IsInt() @Min(0) @Max(0) declare managementMaxMinutes: number;
  @ApiProperty() @IsString() @Length(0, 0) declare ipAllowlist: string;
  @ApiProperty() @IsInt() @Min(3) @Max(30) declare lockoutAttempts: number;
  @ApiProperty() @IsBoolean() declare notifyPaymentFailed: boolean;
  @ApiProperty() @IsBoolean() declare notifyTrialEnding: boolean;
  @ApiProperty() @IsBoolean() declare notifyTicketAssigned: boolean;
  @ApiProperty() @IsBoolean() declare notifyIncident: boolean;
  @ApiProperty() @IsString() @Length(0, 500) declare supportUrl: string;
  @ApiProperty() @Matches(/^#[a-fA-F0-9]{6}$/) declare primaryColor: string;
}
export class SettingsChange extends AdminVersion {
  @ApiProperty({ type: SettingsValue })
  @ValidateNested()
  @Type(() => SettingsValue)
  declare value: SettingsValue;
}
