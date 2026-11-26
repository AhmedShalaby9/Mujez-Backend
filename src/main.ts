import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { json } from "express";
import { AppModule } from "./app.module.js";
import { ENV, type Environment } from "./config/env.js";
import { configureApp } from "./common/http/configure-app.js";
async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: true });
  // Deal submissions can carry documents. Keep the larger limit on this route only.
  app.use("/api/v1/brokerage/deals", json({ limit: "15mb" }));
  // Nest skips its global JSON parser when it sees the route parser above.
  // Register the normal parser explicitly so login and other writes keep their bodies.
  app.use(json());
  const env = app.get<Environment>(ENV);
  configureApp(app, env);
  await app.listen(env.PORT, "0.0.0.0");
}
bootstrap().catch(() => {
  console.error(
    "Mujez startup failed. Check configuration and service availability.",
  );
  process.exitCode = 1;
});
