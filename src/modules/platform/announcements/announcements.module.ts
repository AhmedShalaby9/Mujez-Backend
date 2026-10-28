import { Module } from "@nestjs/common";
import {
  AnnouncementsController,
  CompanyAnnouncementsController,
} from "./announcements.controller.js";
import { AnnouncementsService } from "./announcements.service.js";
@Module({
  controllers: [AnnouncementsController, CompanyAnnouncementsController],
  providers: [AnnouncementsService],
})
export class PlatformAnnouncementsModule {}
