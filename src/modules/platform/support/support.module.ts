import { Module } from "@nestjs/common";
import { SupportController } from "./support.controller.js";
import { SupportService } from "./support.service.js";
@Module({ controllers: [SupportController], providers: [SupportService] })
export class PlatformSupportModule {}
