import { Module } from "@nestjs/common";
import { FeaturesController } from "./features.controller.js";
import { FeaturesService } from "./features.service.js";
@Module({ controllers: [FeaturesController], providers: [FeaturesService] })
export class PlatformFeaturesModule {}
