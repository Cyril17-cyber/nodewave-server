import cors from "cors";
import express from "express";
import helmet from "helmet";
import { config } from "./config.js";
import { pool } from "./db/pool.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import artisteRoutes from "./routes/artistes.js";
import authRoutes from "./routes/auth.js";
import favoriteRoutes from "./routes/favorites.js";
import mediaRoutes from "./routes/media.js";
import meRoutes from "./routes/me.js";
import playlistRoutes from "./routes/playlists.js";
import searchRoutes from "./routes/search.js";
import trackRoutes from "./routes/tracks.js";
import uploadRoutes from "./routes/uploads.js";
import walletRoutes from "./routes/wallets.js";

export function createApp() {
  const app = express();
  app.set("trust proxy", config.TRUST_PROXY);
  app.disable("x-powered-by");

  app.use(helmet());
  // Auth is a bearer token, not cookies, so credentials aren't needed. Native apps send no Origin.
  app.use(cors({ origin: config.CORS_ORIGINS }));
  app.use(express.json({ limit: "100kb" }));

  app.get("/health", async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  });

  const v1 = express.Router();
  v1.use("/auth", authRoutes);
  v1.use("/me", meRoutes);
  v1.use("/wallets", walletRoutes);
  v1.use("/playlists", playlistRoutes);
  v1.use("/artistes", artisteRoutes);
  v1.use("/media", mediaRoutes);
  v1.use("/tracks", trackRoutes);
  v1.use("/favorites", favoriteRoutes);
  v1.use("/search", searchRoutes);
  v1.use("/uploads", uploadRoutes);
  app.use("/v1", v1);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
