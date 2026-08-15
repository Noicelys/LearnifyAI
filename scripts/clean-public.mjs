import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Vite refuses to empty an outDir that sits outside its root, so old hashed
// assets would pile up in public/ on every build.
const publicDir = fileURLToPath(new URL("../public", import.meta.url));
await rm(publicDir, { recursive: true, force: true });
