import { OAuth2Client } from "google-auth-library";
import { config } from "../config.js";
import { unauthorized, unavailable } from "./errors.js";

const googleClient = new OAuth2Client();

/**
 * Verifies a Google ID token (from NextAuth on web or Google Sign-In on mobile)
 * and returns the identity it proves.
 */
export async function verifyGoogleIdToken(idToken) {
  if (!config.GOOGLE_CLIENT_IDS.length) throw unavailable("Google sign-in is not configured");
  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: config.GOOGLE_CLIENT_IDS });
    payload = ticket.getPayload();
  } catch {
    throw unauthorized("Invalid Google token", "INVALID_OAUTH_TOKEN");
  }
  if (!payload?.email) throw unauthorized("Google account has no email", "INVALID_OAUTH_TOKEN");
  return {
    provider: "google",
    providerAccountId: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true,
    name: payload.name || payload.email.split("@")[0],
    image: payload.picture ?? null,
  };
}

/**
 * Verifies a Spotify access token by asking Spotify who it belongs to.
 * Spotify doesn't guarantee the email is verified, so it is treated as unverified.
 */
export async function verifySpotifyAccessToken(accessToken) {
  const response = await fetch("https://api.spotify.com/v1/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw unauthorized("Invalid Spotify token", "INVALID_OAUTH_TOKEN");
  const profile = await response.json();
  if (!profile.email) throw unauthorized("Spotify account has no email (user-read-email scope missing)", "INVALID_OAUTH_TOKEN");
  return {
    provider: "spotify",
    providerAccountId: profile.id,
    email: profile.email,
    emailVerified: false,
    name: profile.display_name || profile.email.split("@")[0],
    image: profile.images?.[0]?.url ?? null,
  };
}
