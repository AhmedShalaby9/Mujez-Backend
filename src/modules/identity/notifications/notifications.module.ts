import { WorkspaceToolsController } from "./workspace-tools.controller.js";
import { Module } from "@nestjs/common";
import {
  NotificationsController,
  NotificationPreferencesController,
} from "./notifications.controller.js";
@Module({
  controllers: [
    WorkspaceToolsController,
    NotificationsController,
    NotificationPreferencesController,
  ],
})
export class NotificationsModule {}
