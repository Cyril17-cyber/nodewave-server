import express from "express";
const changePassRouter = express.Router();
import db from "../settings/db.js";
import bodyParser from "body-parser";
import env from "dotenv";
import bcrypt from "bcrypt";
env.config();
const saltRounds = Number(process.env.SALTROUNDS);
import { v4 as uuidv4 } from "uuid";
import sendOTPPasswordChangeEmail from "../nodemailer/sendPassChangeEmail.js";

changePassRouter.get("/:userUuid/:otpNumber", async (req, res) => {
  const { userUuid, otpNumber } = req.params;

  try {
    //find the user
    const userData = await db.query("SELECT * FROM users WHERE uuid = $1", [
      userUuid,
    ]);

    if (userData.rows.length > 0) {
      //we found the user
      const user = userData.rows[0];
      const otpDetails = await db.query(
        "SELECT * FROM otplinks WHERE user_id = $1",
        [user.id]
      );

      const inNumber = Number(otpNumber);

      if (
        otpDetails.rows.length > 0 &&
        otpDetails.rows[0].otp_number === inNumber
      ) {
        const otp = otpDetails.rows[0];

        //checking if the link is expired

        //Convert retrieved timestamps to Date objects
        const expiryDate = new Date(otp.expires_at);
        const currentDate = new Date();

        //check if current date is past the expiry date
        const isExpired = currentDate > expiryDate;

        if (isExpired) {
          //delete the otp
          await db.query("DELETE FROM otplinks WHERE user_id = $1", [
            otp.user_id,
          ]);

          //tell the user the link is expired
          res.status(404).json({
            message: "Expired!!",
          });
        } else {
          //everything worked fine
          res.status(200).json({
            message: "Success!!",
            user: userData.rows[0],
            otp: otp,
          });
        }
      } else {
        //no otp details
        res.status(403).json({
          message: "Link is invalid!",
        });
      }
    } else {
      //Couldn't find user
      console.log("User not found");
      res.status(404).json({
        message: "Server Error: Please try again!",
      });
    }
  } catch (error) {
    console.log("Error: ", error);
    res.status(500).json({
      message: "Server Error: Please try again!",
    });
  }
});

changePassRouter.post("/confirm/:otpLink", async (req, res) => {
  const { otpLink } = req.params;
  const { userEmail, newPassword } = req.body;
  const otpNumber = Number(otpLink);

  if (!otpLink || !userEmail || !newPassword) {
    //details are missing so we can't proceed
    res.status(403).json({
      message: "Input Error: Details Missing",
    });
  } else {
    //finding the user
    try {
      const userData = await db.query("SELECT * FROM users WHERE email = $1", [
        userEmail,
      ]);

      if (userData.rowCount > 0) {
        //found the user
        const user = userData.rows[0];

        //find the otp and confirm if the random generated number is correct

        const otpDetails = await db.query(
          "SELECT * FROM otplinks WHERE user_id = $1",
          [user.id]
        );

        if (
          otpDetails.rowCount > 0 &&
          otpDetails.rows[0].otp_number === otpNumber
        ) {
          //found the otp and it is correct

          bcrypt.hash(newPassword, saltRounds, async (err, hash) => {
            if (err) {
              console.log("Error: ", err);
              res.status(500).json({
                message: "Server Error! Please try again!",
              });
            } else {
              //update the user's password
              await db.query(
                "UPDATE users SET password = $1 WHERE email = $2",
                [hash, user.email]
              );
              //delete the otp
              await db.query("DELETE FROM otplinks WHERE user_id = $1", [
                user.id,
              ]);

              res.status(200).json({
                message: "Success!!",
              });
            }
          });
        } else {
          //no user
          res.status(404).json({
            message: "Input Error: Incorrect Details",
          });
        }
      } else {
        //no user
        res.status(404).json({
          message: "Input Error: Details Missing",
        });
      }
    } catch (error) {
      console.log("Error: ", error);
      res.status(500).json({
        message: "Server Error! Please try again!",
      });
    }
  }
});

export default changePassRouter;
