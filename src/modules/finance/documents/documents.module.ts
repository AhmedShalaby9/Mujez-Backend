import { Module } from "@nestjs/common";
import { SalesLeadsModule } from "../../sales/leads/leads.module.js";
import { DocumentsService } from "./documents.service.js";
import { DocumentsController } from "./documents.controller.js";
@Module({
  imports: [SalesLeadsModule],
  providers: [DocumentsService],
  controllers: [DocumentsController],
})
export class FinanceDocumentsModule {}
