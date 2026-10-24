import { apiPath, makeTone, setup } from "./helpers.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";

// Config is read when setup() imports the app, so these switch full tracks to Supabase Storage
process.env.SUPABASE_URL = "https://project.supabase.test/";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";
process.env.SUPABASE_BUCKET = "tracks";

const { api, pool, createUser } = await setup();

// Stand-ins for Pinata (public files) and Supabase Storage (full tracks)
const objects = new Map();
const supabaseCalls = [];
const realFetch = globalThis.fetch;
const fakeCid = () => `Qm${crypto.randomBytes(22).toString("hex")}`;
const fetchMock = mock.method(globalThis, "fetch", async (url, init = {}) => {
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  const href = String(url);
  if (href.includes("/pinning/pin")) return json({ IpfsHash: fakeCid() });
  if (href.startsWith("https://project.supabase.test/storage/v1/")) {
    const route = href.slice("https://project.supabase.test/storage/v1".length);
    supabaseCalls.push({ method: init.method, route, headers: init.headers });
    if (init.method === "POST" && route.startsWith("/object/sign/tracks/")) {
      const { expiresIn } = JSON.parse(init.body);
      return json({ signedURL: `${route}?token=signed-for-${expiresIn}` });
    }
    if (init.method === "POST" && route.startsWith("/object/tracks/")) {
      objects.set(route.slice("/object/tracks/".length), { bytes: Buffer.from(init.body), type: init.headers["Content-Type"] });
      return json({ Key: route });
    }
    if (init.method === "DELETE" && route === "/object/tracks") {
      for (const name of JSON.parse(init.body).prefixes) objects.delete(name);
      return json([]);
    }
  }
  return realFetch(url, init);
});
after(() => {
  fetchMock.mock.restore();
  return pool.end();
});

const uploadTrack = (user, audio) =>
  api()
    .post("/v1/uploads/track")
    .set(user.auth)
    .field("title", "Cloud")
    .field("coverUri", "ipfs://cover-cid")
    .attach("file", audio, { filename: "track.mp3", contentType: "audio/mpeg" });

describe("full tracks in Supabase Storage", () => {
  let artiste, stranger, audioId, track;

  before(async () => {
    artiste = await createUser();
    stranger = await createUser();
    ({ body: { audioId } } = await uploadTrack(artiste, makeTone({ seconds: 8, frequency: 520 })).expect(201));
    const { rows: [playlist] } = await pool.query(
      "INSERT INTO playlist (playlist_type, cover, title, genre, artiste_id) VALUES ('Single', 'https://x/c', 'Cloud Single', 'Pop', $1) RETURNING *",
      [artiste.user.id]
    );
    ({ rows: [track] } = await pool.query(
      `INSERT INTO music (title, writers, producers, price, price_wei, token_id, artiste_id, album_id, audio_id)
       VALUES ('Cloud', 'W', 'P', '0.01', 10000000000000000, 202, $1, $2, $3) RETURNING *`,
      [artiste.user.id, playlist.id, audioId]
    ));
  });

  it("uploads the full track to the private bucket, not to disk", () => {
    assert.equal(objects.get(audioId)?.type, "audio/mpeg");
    assert.equal(fs.existsSync(path.join(process.env.STORAGE_DIR, "private", audioId)), false);
    const upload = supabaseCalls.find((call) => call.route === `/object/tracks/${audioId}`);
    assert.equal(upload.headers.apikey, "test-service-key");
    assert.equal(upload.headers.Authorization, "Bearer test-service-key");
  });

  it("redirects a verified stream link to a Supabase signed URL that expires with it", async () => {
    await api().get(`/v1/tracks/${track.id}/stream`).set(stranger.auth).expect(403);
    const { body } = await api().get(`/v1/tracks/${track.id}/stream`).set(artiste.auth).expect(200);

    const res = await api().get(apiPath(body.url)).expect(302);
    const remaining = Math.round((body.expiresAt - Date.now()) / 1000);
    const [, expiresIn] = res.headers.location.match(
      new RegExp(`^https://project\\.supabase\\.test/storage/v1/object/sign/tracks/${audioId}\\?token=signed-for-(\\d+)$`)
    );
    assert.ok(Math.abs(Number(expiresIn) - remaining) <= 2);
    assert.match(res.headers["cache-control"], /^private, max-age=\d+$/);

    // The API still checks its own signature before asking Supabase for a link
    const signs = supabaseCalls.filter((call) => call.route.startsWith("/object/sign/")).length;
    const tampered = apiPath(body.url).replace(/sig=[^&]+/, "sig=forged");
    await api().get(tampered).expect(403);
    assert.equal(supabaseCalls.filter((call) => call.route.startsWith("/object/sign/")).length, signs);
  });

  it("deletes an unminted upload from the bucket", async () => {
    const { body } = await uploadTrack(artiste, makeTone({ seconds: 6, frequency: 640 })).expect(201);
    assert.ok(objects.has(body.audioId));
    await api().delete(`/v1/uploads/track/${body.audioId}`).set(artiste.auth).expect(204);
    assert.equal(objects.has(body.audioId), false);
  });
});
