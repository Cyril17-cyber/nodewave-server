import express from "express";
import bodyParser from "body-parser";
import db from "./settings/db.js";
import cors from "cors";
import env from "dotenv";
import {
  authRouter,
  changePassRouter,
  mintRouter,
  getTrackRouter,
} from "./routes/routes.js";

const app = express();
app.use(cors({ origin: "http://localhost:3000", credentials: true }));

const port = process.env.PORT || 3001;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));
app.use(express.json());

db.connect();

app.use("/auth", authRouter);
app.use("/change-pass", changePassRouter);
app.use("/mint", mintRouter);
app.use("/music", getTrackRouter);

//http://localhost:3001/auth/spotify/redirect

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
