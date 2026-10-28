import { env } from "./env.js";
import { poller } from "./poller.js";
import { createServer } from "./server.js";

createServer().listen(env.port, () => console.log(`court-bot listening on port ${env.port}`));
await poller.schedule(0);
