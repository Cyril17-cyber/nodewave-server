import { Router } from "express";
import { notFound } from "../lib/errors.js";
import { selectTracks } from "../lib/tracks.js";
import { accountView } from "../lib/users.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

router.get("/", async (req, res) => {
  const user = await accountView(req.userId);
  if (!user) throw notFound("Account not found", "ACCOUNT_NOT_FOUND");
  res.json({ user });
});

/** Tracks the user owns in any linked wallet (bought, traded for, or their own artiste copy). */
router.get("/library", async (req, res) => {
  const tracks = await selectTracks({ where: "owned.amount > 0", userId: req.userId, orderBy: "m.album_id DESC, m.id" });
  res.json({ tracks });
});

/** Tracks the user has favourited, most recent first. */
router.get("/favorites", async (req, res) => {
  const tracks = await selectTracks({ where: "f.user_id IS NOT NULL", userId: req.userId, orderBy: "f.created_at DESC" });
  res.json({ tracks });
});

export default router;
