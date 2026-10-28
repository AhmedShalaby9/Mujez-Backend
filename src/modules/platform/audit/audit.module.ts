import { Module } from "@nestjs/common";
import { AuditService } from "./audit.service.js";
import { PlatformAuditController } from "./audit.controller.js";
@Module({ controllers: [PlatformAuditController], providers: [AuditService] })
export class PlatformAuditModule {}
