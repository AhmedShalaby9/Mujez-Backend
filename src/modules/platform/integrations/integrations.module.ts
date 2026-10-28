import { Module } from "@nestjs/common";
import { IntegrationsController, IntegrationsService } from "./integrations.js";
@Module({
  controllers: [IntegrationsController],
  providers: [IntegrationsService],
})
export class PlatformIntegrationsModule {}
