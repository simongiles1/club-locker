import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const apiRoot = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(apiRoot, "..", ".env");

if (existsSync(envPath)) {
  loadDotenv({ path: envPath });
}
