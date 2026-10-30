import { Module } from "@nestjs/common";
import { SalesLeadsModule } from "../leads/leads.module.js";
import { TasksController } from "./tasks.controller.js";
import { TasksService } from "./tasks.service.js";
@Module({
  imports: [SalesLeadsModule],
  controllers: [TasksController],
  providers: [TasksService],
})
export class SalesTasksModule {}
