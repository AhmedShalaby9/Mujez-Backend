import { Module } from "@nestjs/common";
import { SalesLeadsModule } from "../leads/leads.module.js";
import { ContactsController } from "./contacts.controller.js";
import { ContactsService } from "./contacts.service.js";
@Module({
  imports: [SalesLeadsModule],
  controllers: [ContactsController],
  providers: [ContactsService],
})
export class SalesContactsModule {}
