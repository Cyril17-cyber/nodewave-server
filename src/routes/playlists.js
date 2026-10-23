import { Router } from "express";
import { formatEther, parseEventLogs } from "viem";
import { z } from "zod";
import { nodewaveAbi, publicClient } from "../chain/client.js";
import { config } from "../config.js";
import { pool, withTransaction } from "../db/pool.js";
import { badRequest, conflict, forbidden, notFound, unavailable } from "../lib/errors.js";
import { listReleases } from "../lib/releases.js";
import { selectTracks } from "../lib/tracks.js";
import { accountView, publicProfile } from "../lib/users.js";
import { optionalAuth, requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();

const MAX_TRACKS = { Single: 1, EP: 6, Album: 20 };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function ordinal(day) {
  if (day >= 11 && day <= 13) return `${day}th`;
  return `${day}${{ 1: "st", 2: "nd", 3: "rd" }[day % 10] ?? "th"}`;
}

const id = z.object({ id: z.coerce.number().int().positive() });
const text = (max) => z.string().trim().max(max);

router.get(
  "/",
  validate({
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).default(30),
      offset: z.coerce.number().int().min(0).default(0),
      type: z.enum(["Single", "EP", "Album"]).optional(),
      artisteId: z.coerce.number().int().positive().optional(),
    }),
  }),
  async (req, res) => {
    const { limit, offset, type, artisteId } = req.query;
    res.json(await listReleases({ limit, offset, type: type ?? null, artisteId: artisteId ?? null }));
  }
);

router.get("/:id", optionalAuth, validate({ params: id }), async (req, res) => {
  const { rows: playlists } = await pool.query("SELECT * FROM playlist WHERE id = $1", [req.params.id]);
  const playlist = playlists[0];
  if (!playlist) throw notFound("This release doesn't exist.", "PLAYLIST_NOT_FOUND");

  const [{ rows: artistes }, trackList] = await Promise.all([
    pool.query("SELECT * FROM users WHERE id = $1", [playlist.artiste_id]),
    selectTracks({ where: "m.album_id = $2", params: [playlist.id], userId: req.userId }),
  ]);

  res.json({
    playlist,
    trackList,
    artiste: publicProfile(artistes[0]),
    user: req.userId ? await accountView(req.userId) : null,
  });
});

/**
 * Registers a release after its mint transaction is mined. Token ids, prices and the
 * artiste come from the transaction's events, never from the client.
 */
router.post(
  "/",
  requireAuth,
  validate({
    body: z.object({
      txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "Invalid transaction hash").toLowerCase(),
      type: z.enum(["Single", "EP", "Album"]),
      title: text(200).min(1),
      genre: text(100).default(""),
      recordLabel: text(200).default(""),
      cover: z.url(),
      tracks: z
        .array(
          z.object({
            title: text(200).min(1),
            featuredArtistes: text(500).default(""),
            writers: text(500).default(""),
            producers: text(500).default(""),
            explicit: z.boolean().default(false),
            songDuration: text(20).default(""),
            // From POST /v1/uploads/track; ties the token to its private full-length audio
            audioId: z.string().regex(/^[0-9a-f]{64}$/, "Invalid audio id"),
          })
        )
        .min(1)
        .max(MAX_TRACKS.Album),
    }),
  }),
  async (req, res) => {
    const { txHash, type, title, genre, recordLabel, cover, tracks } = req.body;
    if (!config.chainEnabled) throw unavailable("Minting is not configured on this server");
    if (tracks.length > MAX_TRACKS[type]) throw badRequest(`A ${type} can have at most ${MAX_TRACKS[type]} tracks`);

    const existing = await pool.query("SELECT id FROM playlist WHERE mint_tx_hash = $1", [txHash]);
    if (existing.rows[0]) throw conflict("This mint has already been registered.", "ALREADY_REGISTERED");

    let receipt;
    try {
      receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
    } catch {
      throw conflict("Transaction isn't confirmed yet. Please try again shortly.", "TX_PENDING");
    }
    if (receipt.status !== "success") throw badRequest("The mint transaction failed on-chain.", "TX_FAILED");
    if (receipt.to?.toLowerCase() !== config.CONTRACT_ADDRESS) {
      throw badRequest("Transaction isn't a NodeWave mint.", "WRONG_CONTRACT");
    }

    const minted = parseEventLogs({
      abi: nodewaveAbi,
      eventName: "MarketItemCreated",
      logs: receipt.logs.filter((log) => log.address.toLowerCase() === config.CONTRACT_ADDRESS),
    });
    if (!minted.length) throw badRequest("Transaction didn't mint any tracks.", "NOTHING_MINTED");
    if (minted.length !== tracks.length) {
      throw badRequest(`Transaction minted ${minted.length} tracks but ${tracks.length} were described.`, "TRACK_MISMATCH");
    }

    const artisteAddress = minted[0].args.artiste.toLowerCase();
    const { rows: wallets } = await pool.query("SELECT 1 FROM wallets WHERE address = $1 AND user_id = $2", [
      artisteAddress,
      req.userId,
    ]);
    if (!wallets[0]) {
      throw forbidden("Link the wallet that minted this release to your account first.", "WALLET_NOT_LINKED");
    }

    // Each token must have been minted with the metadata the API made for this user's upload,
    // so nobody can attach audio to a token they didn't create (or reuse an upload twice)
    const audioIds = tracks.map((t) => t.audioId);
    if (new Set(audioIds).size !== audioIds.length) throw badRequest("Each track needs its own audio.", "AUDIO_MISMATCH");
    const { rows: audios } = await pool.query(
      `SELECT a.id, a.metadata_uri FROM audio_files a
       WHERE a.id = ANY($1) AND a.user_id = $2 AND NOT EXISTS (SELECT 1 FROM music m WHERE m.audio_id = a.id)`,
      [audioIds, req.userId]
    );
    const metadataUri = new Map(audios.map((a) => [a.id, a.metadata_uri]));
    tracks.forEach((song, index) => {
      if (metadataUri.get(song.audioId) !== minted[index].args.uri) {
        throw badRequest(`Track ${index + 1} wasn't minted with its uploaded audio.`, "AUDIO_MISMATCH");
      }
    });

    const now = new Date();
    const releaseDay = `${ordinal(now.getUTCDate())} ${MONTHS[now.getUTCMonth()]}`;
    const releaseYear = String(now.getUTCFullYear());

    const playlist = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO playlist (playlist_type, cover, title, genre, artiste_id, record_label, mint_tx_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [type, cover, title, genre, req.userId, recordLabel, txHash]
      );

      for (const [index, song] of tracks.entries()) {
        const { tokenId, price } = minted[index].args;
        await client.query(
          `INSERT INTO music (title, featured_artistes, writers, producers, explicit, song_duration,
                              price, price_wei, token_id, artiste_id, album_id, release_day, release_year, audio_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            song.title, song.featuredArtistes, song.writers, song.producers, song.explicit, song.songDuration,
            formatEther(price), price.toString(), tokenId.toString(), req.userId, rows[0].id, releaseDay, releaseYear, song.audioId,
          ]
        );
      }
      return rows[0];
    });

    const trackList = await selectTracks({ where: "m.album_id = $2", params: [playlist.id], userId: req.userId });
    res.status(201).json({ playlist, trackList });
  }
);

export default router;
