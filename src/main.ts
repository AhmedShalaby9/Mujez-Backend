import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { ENV, type Environment } from "./config/env.js";
import { configureApp } from "./common/http/configure-app.js";
async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: true });
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
