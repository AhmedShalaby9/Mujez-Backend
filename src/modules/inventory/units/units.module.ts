import { Module } from "@nestjs/common";
import { InventoryProjectsModule } from "../projects/projects.module.js";
import { UnitsController } from "./units.controller.js";
@Module({ imports: [InventoryProjectsModule], controllers: [UnitsController] })
export class InventoryUnitsModule {}
