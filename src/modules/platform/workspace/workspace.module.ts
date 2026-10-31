import { Module } from "@nestjs/common";
import {
  WorkspaceEntryController,
  WorkspaceSessionController,
} from "./workspace.controller.js";
import { WorkspaceService } from "./workspace.service.js";
@Module({
  controllers: [WorkspaceEntryController, WorkspaceSessionController],
  providers: [WorkspaceService],
  exports: [WorkspaceService],
})
export class PlatformWorkspaceModule {}
