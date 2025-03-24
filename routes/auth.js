import express from "express";
const authRouter = express.Router();
import db from "../settings/db.js";
import bodyParser from "body-parser";
import env from "dotenv";
import bcrypt from "bcrypt";
env.config();
const saltRounds = Number(process.env.SALTROUNDS);
import { v4 as uuidv4 } from "uuid";
import sendOTPPasswordChangeEmail from "../nodemailer/sendPassChangeEmail.js";
import sendOTPAccountVerficationEmail from "../nodemailer/sendEmailVerificationMail.js";
const clientUrl = process.env.CLIENTURL;
import _ from "lodash";

authRouter.post("/register", async (req, res) => {
  const { fullName, email, password } = req.body;
  const lowerFirstEmail = _.lowerFirst(email);
  try {
    const checkUser = await db.query("SELECT * FROM users WHERE email = $1", [
      lowerFirstEmail,
    ]);

    if (checkUser.rows.length > 0) {
      //user exists
      res.status(403).json({
        message: "A user with this email already exists.",
        user: null,
      });
    } else {
      //hashing the password and saving it in database
      bcrypt.hash(password, saltRounds, async (err, hash) => {
        if (err) {
          res.status(500).json({
            message: "Server error: Please try again.",
            user: null,
          });
          console.log("Error: ", err);
        } else {
          const userUuid = uuidv4();
          const { rows } = await db.query(
            "INSERT INTO users (name, email, password, display_picture_url, verified, uuid, provider) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *",
            [fullName, lowerFirstEmail, hash, "null", false, userUuid, "null"]
          );
          //getting our user back
          const user = rows[0];

          //sending otp for email verification

          // Delete any previous OTP if it exists
          await db.query("DELETE FROM otplinks WHERE user_id = $1", [user.id]);

          // Generate random numbers for the link

          const randomNumber = `${Math.floor(
            1000000 + Math.random() * 9000000
          )}`;
          const verifyMailLink = `${clientUrl}/verify-mail/${user.uuid}/${randomNumber}`;
          await sendOTPAccountVerficationEmail(
            user,
            res,
            verifyMailLink,
            randomNumber
          );
        }
      });
    }
  } catch (err) {
    console.log("Error: ", err);
    res.status(500).json({
      message: "Server error: Please try again.",
      user: null,
    });
  }
});

authRouter.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const lowerFirstEmail = _.lowerFirst(email);
  try {
    const result = await db.query("SELECT * FROM users WHERE email = $1", [
      lowerFirstEmail,
    ]);
    if (result.rows.length > 0) {
      const user = result.rows[0];
      const userPassword = user.password;
      bcrypt.compare(password, userPassword, (err, result) => {
        if (err) {
          console.log("Error: ", err);
          res.status(500).json({
            message: "Server error: Please try again.",
            user: null,
          });
        } else if (result) {
          //login was successful
          res.status(200).json({
            message: "success",
            user,
          });
        } else {
          res.status(401).json({
            message: "Invalid Password... Please try again.",
            user: null,
          });
        }
      });
    } else {
      res.status(401).json({
        message: "User with said record doesn't exist.",
        user: null,
      });
    }
  } catch (err) {
    console.log("Error: ", err);
    res.status(500).json({
      message: "Server error: Please try again.",
      user: null,
    });
  }
});

authRouter.post("/verify-email/email", async (req, res) => {
  const { email } = req.body;
  const lowerFirstEmail = _.lowerFirst(email);
  const userData = await db.query("SELECT * FROM users WHERE email = $1", [
    lowerFirstEmail,
  ]);

  const user = userData.rows[0];
  try {
    //sending otp for email verification

    // Delete any previous OTP if it exists
    await db.query("DELETE FROM otplinks WHERE user_id = $1", [user.id]);

    // Generate random numbers for the link

    const randomNumber = `${Math.floor(1000000 + Math.random() * 9000000)}`;
    const verifyMailLink = `${clientUrl}/verify-mail/${user.uuid}/${randomNumber}`;
    await sendOTPAccountVerficationEmail(
      user,
      res,
      verifyMailLink,
      randomNumber
    );
  } catch (error) {
    console.log("Error: ", error);
    res.status(500).json({
      message: "Server error: Please try again.",
      user: null,
    });
  }
});

authRouter.post("/verify-mail/resend", async (req, res) => {
  const { userEmail, otpId, userId } = req.body;
  const lowerFirstEmail = _.lowerFirst(userEmail);
  if (
    !userEmail ||
    userEmail === "" ||
    !otpId ||
    otpId === "" ||
    !userId ||
    userId === ""
  ) {
    // Return an error response for empty input
    return res.status(403).json({
      message: "Empty inputs not allowed!",
      user: null,
    });
  } else {
    try {
      const userData = await db.query("SELECT * FROM users WHERE email = $1", [
        lowerFirstEmail,
      ]);

      const user = userData.rows[0];

      if (!(userData.rows.length > 0)) {
        //user does not exist
        return res.status(404).json({
          message: "User not found!",
          user: null,
        });
      } else {
        //user exits
        //delete the previous otp if any
        await db.query("DELETE FROM otplinks WHERE user_id = $1", [user.id]);
        //generate random numbers for link
        const randomNumber = `${Math.floor(1000000 + Math.random() * 9000000)}`;
        const verifyMailLink = `${clientUrl}/verify-mail/${user.uuid}/${randomNumber}`;

        await sendOTPAccountVerficationEmail(
          user,
          res,
          verifyMailLink,
          randomNumber
        );
      }
    } catch (error) {
      console.log("Error: ", error);
      return res.status(500).json({
        message: "Server Error: Please try again!",
        user: null,
      });
    }
  }
});

authRouter.post("/social-login", async (req, res) => {
  const { name, email, image, provider } = req.body;
  console.log(req.body);
  const lowerFirstEmail = _.lowerFirst(email);
  try {
    const checkUser = await db.query("SELECT * FROM users WHERE email = $1", [
      lowerFirstEmail,
    ]);

    if (checkUser.rows.length > 0) {
      //user exists
      res.status(200).json({
        message: "User Exists",
        user: checkUser.rows[0],
      });
    } else {
      const userUuid = uuidv4();
      const { rows } = await db.query(
        "INSERT INTO users (name, email, password, display_picture_url, verified, uuid, provider) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *",
        [name, lowerFirstEmail, userUuid, image, true, userUuid, provider]
      );
      //getting our user back
      const user = rows[0];
      res.status(200).json({
        message: "Success!!",
        user: user,
      });
    }
  } catch (error) {
    throw new Error(error);
  }
});

authRouter.get("/verify-mail/:userUuid/:otpNumber", async (req, res) => {
  const { userUuid, otpNumber } = req.params;
  console.log(req.params);
  try {
    //find the user
    const userData = await db.query("SELECT * FROM users WHERE uuid = $1", [
      userUuid,
    ]);
    if (userData.rows.length > 0) {
      const user = userData.rows[0];
      const otpDetails = await db.query(
        "SELECT * FROM otplinks WHERE user_id = $1",
        [user.id]
      );

      const inNumber = Number(otpNumber);

      if (
        otpDetails.rows.length > 0 &&
        otpDetails.rows[0].otp_number === otpNumber
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
          console.log("is expired");
          res.status(404).json({
            message: "Expired!!",
          });
        } else {
          //everything worked fine
          await db.query("UPDATE users SET verified = $1 WHERE email = $2", [
            true,
            user.email,
          ]);

          await db.query("DELETE FROM otplinks WHERE user_id = $1", [
            otp.user_id,
          ]);
          res.status(200).json({
            message: "Success!!",
            user: userData.rows[0],
            otp: otp,
          });
        }
      } else {
        //no otp details
        console.log("is invalid");
        res.status(403).json({
          message: "Link is invalid!",
        });
      }
    } else {
      //Couldn't find user
      console.log("User not found");
      res.status(500).json({
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

authRouter.post("/change-pass/email", async (req, res) => {
  const { email } = req.body;
  const lowerFirstEmail = _.lowerFirst(email);

  if (!email || email === "") {
    // Return an error response for empty input
    return res.status(403).json({
      message: "Empty inputs not allowed!",
      user: null,
    });
  } else {
    const userData = await db.query("SELECT * FROM users WHERE email = $1", [
      lowerFirstEmail,
    ]);
    const user = userData.rows[0];

    if (!user) {
      // Return an error response if the user is not found
      return res.status(404).json({
        message: "User not found!",
        user: null,
      });
    } else {
      // User exists, proceed with email sending logic
      try {
        // Delete any previous OTP if it exists
        await db.query("DELETE FROM otplinks WHERE user_id = $1", [user.id]);

        // Generate random numbers for the link
        const randomNumber = `${Math.floor(1000000 + Math.random() * 9000000)}`;
        const resetPassLink = `${clientUrl}/change-pass/${user.uuid}/${randomNumber}`;

        // Send the OTP password change email
        await sendOTPPasswordChangeEmail(
          user,
          res,
          resetPassLink,
          randomNumber
        );
      } catch (error) {
        console.log("Error: ", error);
        // Send a single error response if any error occurs in the try block
        return res.status(500).json({
          message: "Server Error: Please try again!",
          user: null,
        });
      }
    }
  }
});

authRouter.post("/change-pass/resend", async (req, res) => {
  const { userEmail, otpId, userId } = req.body;
  const lowerFirstEmail = _.lowerFirst(userEmail);
  if (
    !userEmail ||
    userEmail === "" ||
    !otpId ||
    otpId === "" ||
    !userId ||
    userId === ""
  ) {
    // Return an error response for empty input
    return res.status(403).json({
      message: "Empty inputs not allowed!",
      user: null,
    });
  } else {
    try {
      const userData = await db.query("SELECT * FROM users WHERE email = $1", [
        lowerFirstEmail,
      ]);

      const user = userData.rows[0];

      if (!(userData.rows.length > 0)) {
        //user does not exist
        return res.status(404).json({
          message: "User not found!",
          user: null,
        });
      } else {
        //user exits
        //delete the previous otp if any
        await db.query("DELETE FROM otplinks WHERE user_id = $1", [user.id]);
        //generate random numbers for link
        const randomNumber = `${Math.floor(1000000 + Math.random() * 9000000)}`;
        const restPassLink = `${clientUrl}/change-pass/${user.uuid}/${randomNumber}`;

        sendOTPPasswordChangeEmail(user, res, restPassLink, randomNumber);
      }
    } catch (error) {
      console.log("Error: ", error);
      return res.status(500).json({
        message: "Server Error: Please try again!",
        user: null,
      });
    }
  }
});

export default authRouter;
