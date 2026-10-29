// Prints the gateway's merged OpenAPI document (no server, no database).
import { buildOpenApi } from "../src/openapi";

console.log(JSON.stringify(buildOpenApi(), null, 2));
