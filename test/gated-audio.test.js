import { apiPath, makeTone, setup } from "./helpers.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { after, before, describe, it, mock } from "node:test";

const { api, pool, createUser } = await setup();

// Pinata stand-in: remembers what was pinned
const pinned = { files: [], json: [] };
const realFetch = globalThis.fetch;
const fakeCid = () => `Qm${crypto.randomBytes(22).toString("hex")}`;
const fetchMock = mock.method(globalThis, "fetch", async (url, init) => {
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  if (String(url).endsWith("/pinning/pinFileToIPFS")) {
    const file = init.body.get("file");
    const cid = fakeCid();
    pinned.files.push({ cid, bytes: Buffer.from(await file.arrayBuffer()) });
    return json({ IpfsHash: cid });
  }
  if (String(url).endsWith("/pinning/pinJSONToIPFS")) {
    const cid = fakeCid();
    pinned.json.push({ cid, content: JSON.parse(init.body).pinataContent });
    return json({ IpfsHash: cid });
  }
  return realFetch(url, init);
});
after(() => {
  fetchMock.mock.restore();
  return pool.end();
});

/** Seconds of audio in an MP3, measured by decoding it (ffmpeg reports progress on stderr). */
function durationOf(bytes) {
  const { stderr } = spawnSync(ffmpegPath, ["-hide_banner", "-i", "pipe:0", "-f", "null", "-"], { input: bytes });
  const [, h, m, s] = [...stderr.toString().matchAll(/time=(\d+):(\d+):([\d.]+)/g)].at(-1);
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

const uploadTrack = (user, audio, fields = {}) =>
  api()
    .post("/v1/uploads/track")
    .set(user.auth)
    .field("title", fields.title ?? "Midnight")
    .field("coverUri", fields.coverUri ?? "ipfs://cover-cid")
    .field("genre", "Afrobeats")
    .field("explicit", "true")
    .attach("file", audio, { filename: "track.mp3", contentType: fields.contentType ?? "audio/mpeg" });

describe("uploading a track", () => {
  it("stores the full audio privately and publishes a 30s preview plus metadata", async () => {
    const artiste = await createUser();
    const audio = makeTone({ seconds: 45, frequency: 330 });
    const res = await uploadTrack(artiste, audio).expect(201);

    assert.match(res.body.audioId, /^[0-9a-f]{64}$/);
    assert.equal(res.body.audioId, crypto.createHash("sha256").update(audio).digest("hex"));
    const stored = fs.readFileSync(path.join(process.env.STORAGE_DIR, "private", res.body.audioId));
    assert.ok(stored.equals(audio), "full track kept on the API's disk");

    // Only the preview went to IPFS, never the full track
    assert.equal(pinned.files.length, 1);
    const preview = pinned.files[0];
    assert.ok(!preview.bytes.equals(audio));
    assert.ok(Math.abs(durationOf(preview.bytes) - 30) < 1, "preview is 30 seconds");
    assert.equal(res.body.previewUrl, `https://test.mypinata.cloud/ipfs/${preview.cid}`);

    const metadata = pinned.json.at(-1);
    assert.equal(res.body.uri, `ipfs://${metadata.cid}`);
    assert.equal(metadata.content.name, "Midnight");
    assert.equal(metadata.content.image, "ipfs://cover-cid");
    assert.equal(metadata.content.animation_url, `ipfs://${preview.cid}`);
    assert.equal(metadata.content.properties.audio_sha256, res.body.audioId);
    assert.deepEqual(metadata.content.attributes.find((a) => a.trait_type === "Explicit"), { trait_type: "Explicit", value: true });
  });

  it("rejects files that aren't audio", async () => {
    const artiste = await createUser();
    const notAudio = await uploadTrack(artiste, Buffer.from("definitely not an mp3")).expect(400);
    assert.equal(notAudio.body.code, "UNSUPPORTED_AUDIO");
    const image = await uploadTrack(artiste, Buffer.from("png"), { contentType: "image/png" }).expect(400);
    assert.equal(image.body.code, "WRONG_FILE_TYPE");
    // Full tracks can no longer go to public storage through the old endpoint
    await api().post("/v1/uploads?kind=audio").set(artiste.auth).attach("file", Buffer.from("x"), "a.mp3").expect(400);
  });

  it("won't let someone else claim audio that's already uploaded, but lets the uploader retry", async () => {
    const owner = await createUser();
    const other = await createUser();
    const audio = makeTone({ seconds: 8, frequency: 550 });
    await uploadTrack(owner, audio).expect(201);
    await uploadTrack(owner, audio, { title: "Renamed before minting" }).expect(201);
    const res = await uploadTrack(other, audio).expect(409);
    assert.equal(res.body.code, "AUDIO_EXISTS");
  });

  it("lets the uploader remove an unminted track", async () => {
    const owner = await createUser();
    const { body } = await uploadTrack(owner, makeTone({ seconds: 6, frequency: 610 })).expect(201);
    await api().delete(`/v1/uploads/track/${body.audioId}`).set(owner.auth).expect(204);
    assert.equal(fs.existsSync(path.join(process.env.STORAGE_DIR, "private", body.audioId)), false);
    await api().delete(`/v1/uploads/track/${body.audioId}`).set(owner.auth).expect(404);
  });
});

describe("streaming, listings, plays and artiste pages", () => {
  let artiste, fan, stranger, audio, track, playlist;
  const fanWallet = "0x00000000000000000000000000000000000000f1";

  before(async () => {
    artiste = await createUser("gated-artiste@example.com");
    fan = await createUser();
    stranger = await createUser();
    audio = makeTone({ seconds: 12, frequency: 700 });
    const { body } = await uploadTrack(artiste, audio).expect(201);

    ({ rows: [playlist] } = await pool.query(
      "INSERT INTO playlist (playlist_type, cover, title, genre, artiste_id) VALUES ('Single', 'https://x/c', 'Gated Single', 'Pop', $1) RETURNING *",
      [artiste.user.id]
    ));
    ({ rows: [track] } = await pool.query(
      `INSERT INTO music (title, writers, producers, price, price_wei, token_id, artiste_id, album_id, audio_id)
       VALUES ('Gated', 'W', 'P', '0.01', 10000000000000000, 101, $1, $2, $3) RETURNING *`,
      [artiste.user.id, playlist.id, body.audioId]
    ));
  });

  it("gives everyone the preview but never a link to the full track", async () => {
    const res = await api().get(`/v1/playlists/${playlist.id}`).set(stranger.auth).expect(200);
    const [shown] = res.body.trackList;
    assert.equal(shown.gated, true);
    assert.match(shown.preview_url, /^https:\/\/test\.mypinata\.cloud\/ipfs\//);
    assert.ok(!JSON.stringify(res.body).includes("/v1/media/audio"));
  });

  it("only streams the full track to owners and the artiste", async () => {
    const denied = await api().get(`/v1/tracks/${track.id}/stream`).set(stranger.auth).expect(403);
    assert.equal(denied.body.code, "NOT_OWNED");
    await api().get(`/v1/tracks/${track.id}/stream`).expect(401);

    const { body } = await api().get(`/v1/tracks/${track.id}/stream`).set(artiste.auth).expect(200);
    assert.ok(body.expiresAt > Date.now());
    const full = await api().get(apiPath(body.url)).buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    assert.ok(full.body.equals(audio));
    assert.equal(full.headers["content-type"], "audio/mpeg");
    assert.equal(full.headers["cross-origin-resource-policy"], "cross-origin");

    // Seeking uses Range requests
    const range = await api().get(apiPath(body.url)).set("Range", "bytes=0-99").expect(206);
    assert.equal(Number(range.headers["content-length"]), 100);

    // A tampered or edited link stops working
    const tampered = apiPath(body.url).replace(/exp=\d+/, (m) => `exp=${Number(m.slice(4)) + 1000}`);
    const expired = await api().get(tampered).expect(403);
    assert.equal(expired.body.code, "LINK_EXPIRED");
  });

  it("streams to a collector whose linked wallet holds a copy", async () => {
    await pool.query("INSERT INTO wallets (address, user_id) VALUES ($1, $2)", [fanWallet, fan.user.id]);
    await pool.query("INSERT INTO token_balances (address, token_id, amount) VALUES ($1, 101, 1)", [fanWallet]);
    await api().get(`/v1/tracks/${track.id}/stream`).set(fan.auth).expect(200);
  });

  it("shows resale listings, the cheapest price on the track, and who holds copies", async () => {
    await pool.query(
      "INSERT INTO chain_resale_listings (listing_id, seller_address, token_id, amount, price_wei) VALUES (7, $1, 101, 1, 50000000000000000)",
      [fanWallet]
    );
    const listings = await api().get(`/v1/tracks/${track.id}/listings`).set(fan.auth).expect(200);
    assert.deepEqual(
      listings.body.listings.map((l) => [l.listing_id, l.seller_name, l.price, l.mine]),
      [["7", "Test User", "0.05", true]]
    );

    const shown = await api().get(`/v1/playlists/${playlist.id}`).expect(200);
    assert.equal(shown.body.trackList[0].min_resale_price, "0.05");
    assert.equal(shown.body.trackList[0].resale_listings, 1);

    const holders = await api().get(`/v1/tracks/${track.id}/holders`).set(artiste.auth).expect(200);
    assert.deepEqual(holders.body.holders.map((h) => [h.user_id, h.address, h.amount]), [[fan.user.id, fanWallet, 1]]);

    const mine = await api().get("/v1/me/listings").set(fan.auth).expect(200);
    assert.deepEqual(mine.body.listings.map((l) => [l.track_id, l.price]), [[track.id, "0.05"]]);
  });

  it("records plays (ignoring quick repeats) and lists recently played", async () => {
    await api().post("/v1/me/plays").set(fan.auth).send({ trackId: track.id }).expect(204);
    await api().post("/v1/me/plays").set(fan.auth).send({ trackId: track.id, preview: true }).expect(204);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM plays WHERE user_id = $1", [fan.user.id]);
    assert.equal(rows[0].n, 1);

    const recent = await api().get("/v1/me/recent").set(fan.auth).expect(200);
    assert.deepEqual(recent.body.tracks.map((t) => t.id), [track.id]);
    await api().post("/v1/me/plays").set(fan.auth).send({ trackId: 999999 }).expect(204);
  });

  it("serves artiste pages and filters the marketplace by artiste", async () => {
    const page = await api().get(`/v1/artistes/${artiste.user.id}`).expect(200);
    assert.equal(page.body.artiste.release_count, 1);
    assert.deepEqual(page.body.playlists.map((p) => p.title), ["Gated Single"]);
    assert.equal(page.body.artiste.email, undefined);

    await api().get(`/v1/artistes/${stranger.user.id}`).expect(404);
    const filtered = await api().get("/v1/playlists").query({ artisteId: artiste.user.id }).expect(200);
    assert.deepEqual(filtered.body.playlists.map((p) => p.id), [playlist.id]);
  });
});
