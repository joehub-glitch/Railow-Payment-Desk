// Vercel entry point. Vercel runs the Express app as a serverless function.
// Use Upstash Redis in production: serverless instances do not share memory.
import { app } from "../src/app.js";
export default app;
