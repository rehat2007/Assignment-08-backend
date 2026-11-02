import { Router } from "express";
import { col } from "../db.js";
import { badRequest } from "../errors.js";
import { toEmail } from "../validate.js";

const router = Router();

/* ---------------------------------------------------------------------------
 * POST /api/newsletter — footer "Join" form. Duplicate emails are skipped
 * with a friendly "already on the list" message rather than an error.
 * ------------------------------------------------------------------------- */
router.post("/", async (req, res) => {
  const email = toEmail(req.body?.email);

  try {
    await col("newsletterSubscriber").insertOne({
      email,
      subscribedAt: new Date(),
    });
    res.status(201).json({ message: "You're on the list — talk soon!" });
  } catch (error) {
    if (error?.code === 11000) {
      res.json({ message: "You're already on the list." });
      return;
    }
    throw badRequest("Could not subscribe right now — please retry.");
  }
});

export default router;
