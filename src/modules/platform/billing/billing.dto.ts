import { Transform } from "class-transformer";
import {
  IsString,
  IsInt,
  Min,
  Max,
  IsIn,
  Length,
  Matches,
  IsUUID,
  IsOptional,
  IsDateString,
} from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
export class RequestInput {
  @ApiProperty() @IsUUID() declare requestId: string;
}
export class InvoiceInput extends RequestInput {
  @ApiProperty() @IsString() @Length(3, 80) declare companyId: string;
  @ApiProperty()
  @IsOptional()
  @IsString()
  @Length(3, 80)
  declare subscriptionId?: string;
  @ApiProperty()
  @IsString()
  @Length(2, 500)
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  declare description: string;
  @ApiProperty()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  declare issueDate: string;
  @ApiProperty()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  declare dueDate: string;
  @ApiProperty() @Matches(/^[1-9]\d{0,12}$/) declare subtotalMinor: string;
  @ApiProperty() @IsInt() @Min(0) @Max(10000) declare taxBps: number;
}
export class InvoiceVersion extends RequestInput {
  @ApiProperty() @IsInt() @Min(0) declare version: number;
}
export class PaymentInput extends InvoiceVersion {
  @ApiProperty() @Matches(/^[1-9]\d{0,12}$/) declare amountMinor: string;
  @ApiProperty() @IsIn(["bank", "card", "instapay"]) declare method: string;
  @ApiProperty()
  @IsString()
  @Length(3, 120)
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  declare reference: string;
  @ApiProperty() @IsDateString({ strict: true }) declare paidAt: string;
}
export class SensitiveInput extends InvoiceVersion {
  @ApiProperty()
  @IsString()
  @Length(5, 500)
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  declare reason: string;
  @ApiProperty() @IsString() @Length(1, 256) declare password: string;
}
export class AdjustmentInput extends SensitiveInput {
  @ApiProperty() @Matches(/^[1-9]\d{0,12}$/) declare amountMinor: string;
}
export class ReconcileInput extends InvoiceVersion {
  @ApiProperty()
  @IsIn(["matched", "unmatched", "pending"])
  declare reconciliation: string;
}
