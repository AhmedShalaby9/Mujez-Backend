import { Module } from "@nestjs/common";
import { SalesLeadsModule } from "../leads/leads.module.js";
import { PipelineController } from "./pipeline.controller.js";
@Module({ imports: [SalesLeadsModule], controllers: [PipelineController] })
export class SalesPipelineModule {}
