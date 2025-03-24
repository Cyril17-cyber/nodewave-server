import transporter from "../settings/nodemailerSettings.js";
import db from "../settings/db.js";
import path from "path";
import { fileURLToPath } from "url";

// Get the directory name equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Construct the file path
const imagePath = path.resolve(__dirname, "../public/images/nodewavelogo1.png");

const sendOTPAccountVerficationEmail = async (
  user,
  res,
  verifyMailLink,
  randomNumber
) => {
  //mail options
  const mailOptions = {
    from: "no-reply@nodewave.com",
    to: user.email,
    subject: "Verify Your Email Address",
    html: `<div style="
display: flex;
flex-direction: column;
padding: 20px 30px;
background: #fff;
color: #1e1e1e;
font-family: 'Gill Sans', 'Gill Sans MT', Calibri, 'Trebuchet MS', sans-serif;
">
    <div style="height: 70px ;width: 70px; align-self: center; margin-bottom: 20px;">
        <img style="width:100%" src="cid:logo" alt="logo">
    </div>

    <p style="margin-bottom: 0px;">Hi ${user.name.split(" ")[0]},</p>
    <p style="margin-bottom: 0px;">Thank you for registering with Nodewave!</p>
    <p style="margin-bottom: 0px;">To complete your registration, please confirm your email address by clicking the link below.</p>
    <p style="margin-bottom: 0px;">If you didn't sign up for Nodewave, please disregard this email.</p>
    <p>Please also note that this link will be <b>void in two hours</b>.Thank you.</p>

    <p style="margin-bottom: 0px;">Welcome aboard!</p>
    <p>From all of us at <a href="http://localhost:3000" style="text-decoration: underline; color: #fe8040; font-weight: 800;">Nodewave.</a></p>
    
        <br>
        <br>
    <a href=${verifyMailLink} style="text-decoration: none; padding: 20px 25px; color: #fff; background: #fe8040; border-radius: 0.25rem; font-weight: 600; text-align: center;">CONFIRM YOUR EMAIL</a>
</div>`,
    attachments: [
      {
        filename: "nodewavelogo1.png",
        path: imagePath,
        cid: "logo",
      },
    ],
  };

  const currentTime = new Date();
  const expiresAt = new Date(currentTime.getTime() + 2 * 60 * 60 * 1000); // 2 hours added

  // Convert dates to ISO format to insert into PostgreSQL
  const currentTimeString = currentTime.toISOString();
  const expiresAtString = expiresAt.toISOString();

  //save otp record
  transporter.sendMail(mailOptions, async (err, info) => {
    if (err) {
      console.log("Error: ", err);
      res.status(500).json({
        message: "Server error: Please try again.",
        user: null,
      });
    } else {
      const { rows } = await db.query(
        "INSERT INTO otplinks (user_id, otp_number, created_at, expires_at) VALUES ($1, $2, $3, $4) RETURNING *",
        [user.id, randomNumber, currentTimeString, expiresAtString]
      );

      //getting the otp details back
      const otp = rows[0];
      res.status(200).json({
        message: "Success!!",
        user: user,
        otp: otp,
      });
    }
  });
};

export default sendOTPAccountVerficationEmail;
