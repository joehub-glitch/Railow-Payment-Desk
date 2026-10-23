// Local / container entry point: `npm run dev` or `npm start`.
import { app } from "./app.js";
import { seed } from "./seed.js";
import { storeKind } from "./store.js";

const port = Number(process.env.PORT ?? 3000);

// In-memory store starts empty on every boot, so seed it automatically for local runs.
if (storeKind === "in-memory") await seed();

app.listen(port, () => console.log(`Payments desk MCP server on http://localhost:${port}/mcp (store: ${storeKind})`));
