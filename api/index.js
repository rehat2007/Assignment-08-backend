// Vercel serverless entry point. vercel.json rewrites every request to /api,
// and src/app.js contains the Express app (no app.listen()).
import app from "../src/app.js";

export default app;
