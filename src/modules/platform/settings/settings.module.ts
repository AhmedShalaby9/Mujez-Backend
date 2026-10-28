import { Global, Module } from "@nestjs/common";
import { SettingsController } from "./settings.controller.js";
import { SettingsService } from "./settings.service.js";
import { ConfirmationService } from "../../../common/auth/confirmation.service.js";
@Global()
@Module({
  controllers: [SettingsController],
  providers: [SettingsService, ConfirmationService],
  exports: [SettingsService, ConfirmationService],
})
export class PlatformSettingsModule {}
