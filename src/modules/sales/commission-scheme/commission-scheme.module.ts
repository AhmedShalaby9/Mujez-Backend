import { Module } from "@nestjs/common";
import { SalesLeadsModule } from "../leads/leads.module.js";
import { CommissionSchemeController } from "./commission-scheme.controller.js";
import { CommissionSchemeService } from "./commission-scheme.service.js";
@Module({
  imports: [SalesLeadsModule],
  controllers: [CommissionSchemeController],
  providers: [CommissionSchemeService],
})
export class CommissionSchemeModule {}
