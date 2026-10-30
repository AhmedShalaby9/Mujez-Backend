import { Module } from "@nestjs/common";
import { SalesLeadsModule } from "../../sales/leads/leads.module.js";
import { InventoryService } from "./inventory.service.js";
import { ProjectsController } from "./projects.controller.js";
@Module({
  imports: [SalesLeadsModule],
  providers: [InventoryService],
  controllers: [ProjectsController],
  exports: [InventoryService],
})
export class InventoryProjectsModule {}
