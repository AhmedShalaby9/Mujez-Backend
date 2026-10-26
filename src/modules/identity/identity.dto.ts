import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
export class ProfileDto {
  @ApiProperty({ format: "uuid" }) declare id: string;
  @ApiProperty({ enum: ["company_admin", "company_user", "platform"] })
  declare pool: string;
  @ApiPropertyOptional({ format: "uuid" }) declare companyId?: string;
  @ApiProperty() declare name: string;
  @ApiProperty({ format: "email" }) declare email: string;
  @ApiProperty() declare role: string;
  @ApiProperty({ enum: ["own", "team", "company", "platform"] })
  declare scope: string;
  @ApiPropertyOptional({ format: "uuid", nullable: true })
  declare teamId?: string;
}
export class PermissionsDto {
  @ApiProperty({ type: [String] }) declare permissions: string[];
}
export class TenantPermissionsDto extends PermissionsDto {
  @ApiProperty({ enum: ["own", "team", "company"] }) declare scope: string;
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  declare teamId: string | null;
}
