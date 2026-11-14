import { Injectable } from "@nestjs/common";
import {
  KimiClient,
  type KimiMessage,
} from "../../../infrastructure/ai/kimi.client.js";
@Injectable()
export class KimiRecommendationGateway {
  createClient() {
    return KimiClient.fromEnvironment();
  }
  assertConfigured() {
    this.createClient();
  }
  complete(messages: KimiMessage[], tokens: number) {
    return this.createClient().complete(messages, tokens);
  }
}
