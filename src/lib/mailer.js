import path from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";
import { config } from "../config.js";
import { OTP_TTL_MINUTES } from "./otp.js";

const logoPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../assets/nodewavelogo1.png");

const transporter = config.isTest
  ? nodemailer.createTransport({ jsonTransport: true })
  : nodemailer.createTransport({
      host: config.MAILHOST,
      port: config.MAILPORT,
      secure: config.MAILPORT === 465,
      auth: config.MAILUSER ? { user: config.MAILUSER, pass: config.MAILPASS } : undefined,
    });

/** Mail sent during tests, newest last. */
export const testOutbox = [];

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function layout({ name, paragraphs, code, buttonLabel, buttonUrl }) {
  const firstName = escapeHtml((name || "there").split(" ")[0]);
  return `<div style="padding: 20px 30px; background: #fff; color: #1e1e1e; font-family: 'Gill Sans', 'Gill Sans MT', Calibri, 'Trebuchet MS', sans-serif;">
  <div style="height: 70px; width: 70px; margin: 0 auto 20px;"><img style="width: 100%" src="cid:logo" alt="Nodewave"></div>
  <p>Hi ${firstName},</p>
  ${paragraphs.map((p) => `<p>${p}</p>`).join("\n  ")}
  <p style="font-size: 32px; font-weight: 800; letter-spacing: 8px; color: #fe8040; text-align: center;">${code}</p>
  <p>This code expires in <b>${OTP_TTL_MINUTES} minutes</b>.</p>
  <p style="text-align: center; margin: 30px 0;">
    <a href="${buttonUrl}" style="text-decoration: none; padding: 16px 24px; color: #fff; background: #fe8040; border-radius: 0.25rem; font-weight: 600;">${buttonLabel}</a>
  </p>
  <p>From all of us at <a href="${config.CLIENTURL}" style="color: #fe8040; font-weight: 800;">Nodewave</a>.</p>
</div>`;
}

async function send({ to, subject, html, text, meta }) {
  const message = {
    from: config.MAIL_FROM,
    to,
    subject,
    html,
    text,
    attachments: [{ filename: "nodewavelogo1.png", path: logoPath, cid: "logo" }],
  };
  if (config.isTest) {
    testOutbox.push({ to, subject, ...meta });
    return;
  }
  await transporter.sendMail(message);
}

const codeLink = (page, email, code) => `${config.CLIENTURL}/${page}/${encodeURIComponent(email)}/${code}`;

export function sendVerificationEmail(user, code) {
  return send({
    to: user.email,
    subject: `${code} is your Nodewave verification code`,
    text: `Your Nodewave verification code is ${code}. It expires in ${OTP_TTL_MINUTES} minutes.`,
    html: layout({
      name: user.name,
      paragraphs: [
        "Thank you for registering with Nodewave!",
        "Enter this code in the app to confirm your email address, or use the button below. If you didn't sign up for Nodewave, you can ignore this email.",
      ],
      code,
      buttonLabel: "CONFIRM YOUR EMAIL",
      buttonUrl: codeLink("verify-mail", user.email, code),
    }),
    meta: { purpose: "verify_email", code },
  });
}

export function sendPasswordResetEmail(user, code) {
  return send({
    to: user.email,
    subject: `${code} is your Nodewave password reset code`,
    text: `Your Nodewave password reset code is ${code}. It expires in ${OTP_TTL_MINUTES} minutes.`,
    html: layout({
      name: user.name,
      paragraphs: [
        "We received a request to reset your password. Enter this code in the app, or use the button below.",
        "If you didn't ask to reset your password, you can ignore this email — your password won't change.",
      ],
      code,
      buttonLabel: "RESET PASSWORD",
      buttonUrl: codeLink("change-pass", user.email, code),
    }),
    meta: { purpose: "reset_password", code },
  });
}
