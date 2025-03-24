import nodemailer from "nodemailer";
import env from "dotenv";
env.config();

const mailPort = Number(process.env.MAILPORT);

// Create a transporter object for node mailer
const transporter = nodemailer.createTransport({
  host: process.env.MAILHOST,
  port: mailPort,
  secure: false, // use SSL
  auth: {
    user: process.env.MAILUSER,
    pass: process.env.MAILPASS,
  },
});

export default transporter;
