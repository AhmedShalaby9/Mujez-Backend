import { Module } from "@nestjs/common";
import { PlatformAccessController } from "./access.controller.js";
import { PlatformAccessService } from "./access.service.js";
@Module({
  controllers: [PlatformAccessController],
  providers: [PlatformAccessService],
})
export class PlatformRolesModule {}
