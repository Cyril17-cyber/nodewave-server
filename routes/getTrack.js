import express from "express";
import db from "../settings/db.js";
const getTrackRouter = express.Router();
import bodyParser from "body-parser";

getTrackRouter.get("/playlist/:playlistId", async (req, res) => {
  const { playlistId } = req.params;

  try {
    //find the playlist from our database
    const { rows: playlistDataRows } = await db.query(
      "SELECT * FROM playlist WHERE id = $1",
      [playlistId]
    );

    if (playlistDataRows.length > 0) {
      //found the album

      //fetch the artistes details
      const { rows: artisteDataRows } = await db.query(
        "SELECT * FROM users WHERE id = $1",
        [playlistDataRows[0].artiste_id]
      );

      //fetch all the tracks in the album
      const { rows: musicDataRows } = await db.query(
        "SELECT * FROM music WHERE album_id = $1",
        [playlistDataRows[0].id]
      );
      if (artisteDataRows.length > 0 && musicDataRows.length > 0) {
        res.status(200).json({
          message: "Success!!",
          playlist: playlistDataRows[0],
          trackList: musicDataRows,
          artiste: artisteDataRows[0],
        });
      } else {
        console.log("404 hit for no music");
        //no music or artiste details
        res.status(404).json({
          message: "Link is invalid!",
        });
      }
    } else {
      //no playlist details
      res.status(404).json({
        message: "Link is invalid!",
      });
    }
  } catch (error) {
    console.log("Error: ", error);
    res.status(500).json({
      message: "Server Error: Please try again!",
    });
  }
});

export default getTrackRouter;
