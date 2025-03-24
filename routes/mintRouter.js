import express from "express";
import db from "../settings/db.js";
const mintRouter = express.Router();
import bodyParser from "body-parser";

mintRouter.post("/:nftType", async (req, res) => {
  const { nftType } = req.params;
  const {
    cover,
    title,
    genre,
    trackList,
    artisteId,
    releaseDay,
    releaseYear,
    recordLabel,
  } = req.body;

  try {
    const { rows: albumRows } = await db.query(
      "INSERT INTO playlist (playlist_type, cover, title, genre, artiste_id, record_label) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
      [nftType, cover, title, genre, artisteId, recordLabel]
    );

    const album = albumRows[0];
    console.log("trackList: ", trackList);
    for (const song of trackList) {
      console.log("song:", song);
      const { rows: songRows } = await db.query(
        "INSERT INTO music (title, featured_artistes, writers, producers, explicit, song_duration, price, token_id, artiste_id, album_id, release_day, release_year) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12 ) RETURNING *",
        [
          song.title,
          song.featuredArtistes,
          song.writers,
          song.producers,
          song.explicit,
          song.songDuration,
          song.price,
          song.tokenId,
          artisteId,
          album.id,
          releaseDay,
          releaseYear,
        ]
      );
      const songDetails = songRows[0];
    }

    res.status(200).json({
      message: "Success!!",
      album: album,
    });
  } catch (error) {
    console.log("Music upload error: ", error);
    res.status(500).json({
      message: "Error!!",
    });
  }
});

export default mintRouter;
