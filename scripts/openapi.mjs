import "reflect-metadata";
import { readFile, writeFile } from "node:fs/promises";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { parseEnv } from "node:util";
import { format } from "prettier";
// Documentation generation uses example configuration and never connects to services.
for (const [key, value] of Object.entries(
  parseEnv(await readFile(new URL("../.env.example", import.meta.url), "utf8")),
))
  process.env[key] ??= value;
const { AppModule } = await import("../dist/app.module.js");
const app = await NestFactory.create(AppModule, { logger: false });
try {
  const options = new DocumentBuilder()
    .setTitle("Mujez CRM Foundation API")
    .setDescription(
      "Foundation endpoints only. Business modules and controlled support access are not implemented yet.",
    )
    .setVersion("0.1.0")
    .addBearerAuth(
      { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      "tenant",
    )
    .addBearerAuth(
      { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      "platform",
    )
    .build();
  const document = SwaggerModule.createDocument(app, options);
  document.openapi = "3.1.0";
  // OpenAPI 3.1 uses JSON Schema null unions instead of 3.0's nullable keyword.
  function normalize(value) {
    if (!value || typeof value !== "object") return;
    if (value.nullable && typeof value.type === "string") {
      value.type = [value.type, "null"];
      delete value.nullable;
    }
    for (const child of Object.values(value)) normalize(child);
  }
  normalize(document);
  await writeFile(
    new URL("../docs/openapi.json", import.meta.url),
    await format(JSON.stringify(document), { parser: "json" }),
  );
} finally {
  await app.close();
}
