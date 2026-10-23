import { setup } from "./helpers.js";
import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";

const { api, pool, lastCode, createUser, testOutbox } = await setup();
after(() => pool.end());

// Stand-in for external HTTP services (Spotify, Pinata) so tests never leave the machine
const realFetch = globalThis.fetch;
function stubFetch(routes) {
  return mock.method(globalThis, "fetch", async (url, init) => {
    for (const [prefix, respond] of Object.entries(routes)) {
      if (String(url).startsWith(prefix)) return respond(url, init);
    }
    return realFetch(url, init);
  });
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function seedRelease(artisteId, { album = "Album 100%", song = "Song_One" } = {}) {
  const { rows: [playlist] } = await pool.query(
    "INSERT INTO playlist (playlist_type, cover, title, genre, artiste_id) VALUES ('Album', 'https://x/cover', $2, 'Afrobeats', $1) RETURNING *",
    [artisteId, album]
  );
  const { rows: [track] } = await pool.query(
    `INSERT INTO music (title, writers, producers, price, price_wei, token_id, artiste_id, album_id)
     VALUES ($3, 'W', 'P', '0.01', 10000000000000000, (SELECT coalesce(max(token_id), 0) + 1 FROM music), $1, $2) RETURNING *`,
    [artisteId, playlist.id, song]
  );
  return { playlist, track };
}

const assertNoSecrets = (body) => {
  const text = JSON.stringify(body);
  assert.ok(!text.includes('"password"'), "response must not contain password hashes");
  assert.ok(!/\$2[aby]\$/.test(text), "response must not contain bcrypt hashes");
};

describe("registration and email verification", () => {
  it("registers, emails a code, and only signs in after verification", async () => {
    const email = "New.Person@Example.COM";
    const reg = await api().post("/v1/auth/register").send({ name: "New Person", email, password: "longenough" }).expect(201);
    assertNoSecrets(reg.body);
    assert.equal(reg.body.user.email, "new.person@example.com");
    assert.equal(reg.body.user.verified, false);

    const code = lastCode("new.person@example.com", "verify_email");
    assert.match(code, /^\d{6}$/);
    assert.ok(!JSON.stringify(reg.body).includes(code), "the code must only be sent by email");

    const blocked = await api().post("/v1/auth/login").send({ email, password: "longenough" }).expect(403);
    assert.equal(blocked.body.code, "EMAIL_NOT_VERIFIED");

    await api().post("/v1/auth/verify-email").send({ email, code: "000000" === code ? "111111" : "000000" }).expect(400);
    const verified = await api().post("/v1/auth/verify-email").send({ email, code }).expect(200);
    assert.ok(verified.body.accessToken && verified.body.refreshToken);
    assert.equal(verified.body.user.verified, true);

    // Codes are single use
    await api().post("/v1/auth/verify-email").send({ email, code }).expect(400);

    // Emails are matched case-insensitively
    const login = await api().post("/v1/auth/login").send({ email: "new.person@example.com", password: "longenough" }).expect(200);
    assertNoSecrets(login.body);
  });

  it("rejects duplicate emails regardless of case", async () => {
    await createUser("dupe@example.com");
    const res = await api().post("/v1/auth/register").send({ name: "X", email: "DUPE@example.com", password: "longenough" }).expect(409);
    assert.equal(res.body.code, "EMAIL_IN_USE");
  });

  it("validates input", async () => {
    const res = await api().post("/v1/auth/register").send({ name: "X", email: "not-an-email", password: "short" }).expect(400);
    assert.equal(res.body.code, "VALIDATION_ERROR");
  });

  it("burns a code after 5 wrong guesses", async () => {
    const email = "guesser@example.com";
    await api().post("/v1/auth/register").send({ name: "G", email, password: "longenough" }).expect(201);
    const code = lastCode(email, "verify_email");
    const wrong = code === "123456" ? "654321" : "123456";
    for (let i = 0; i < 5; i++) await api().post("/v1/auth/verify-email").send({ email, code: wrong }).expect(400);
    await api().post("/v1/auth/verify-email").send({ email, code }).expect(400);
  });

  it("answers resend the same way for unknown emails", async () => {
    const res = await api().post("/v1/auth/verify-email/resend").send({ email: "nobody@example.com" }).expect(200);
    assert.match(res.body.message, /If that account/);
  });
});

describe("login", () => {
  it("gives the same answer for a wrong password and an unknown email", async () => {
    const user = await createUser();
    const wrongPassword = await api().post("/v1/auth/login").send({ email: user.email, password: "nope-nope" }).expect(401);
    const unknown = await api().post("/v1/auth/login").send({ email: "ghost@example.com", password: "nope-nope" }).expect(401);
    assert.deepEqual(wrongPassword.body, unknown.body);
  });
});

describe("password reset", () => {
  it("resets with the emailed code and signs out every session", async () => {
    const user = await createUser("reset@example.com", "old-password");
    const forgot = await api().post("/v1/auth/password/forgot").send({ email: user.email }).expect(200);
    const code = lastCode(user.email, "reset_password");
    assert.ok(!JSON.stringify(forgot.body).includes(code));

    await api().post("/v1/auth/password/reset").send({ email: user.email, code, password: "new-password" }).expect(200);
    await api().post("/v1/auth/login").send({ email: user.email, password: "old-password" }).expect(401);
    await api().post("/v1/auth/login").send({ email: user.email, password: "new-password" }).expect(200);
    await api().post("/v1/auth/refresh").send({ refreshToken: user.refreshToken }).expect(401);
  });

  it("doesn't reveal whether an email has an account", async () => {
    const res = await api().post("/v1/auth/password/forgot").send({ email: "ghost@example.com" }).expect(200);
    assert.match(res.body.message, /If an account exists/);
  });
});

describe("sessions", () => {
  it("rotates refresh tokens and revokes that login's tokens when an old one is reused", async () => {
    const user = await createUser();
    const otherDevice = await api()
      .post("/v1/auth/login")
      .send({ email: user.email, password: user.password })
      .expect(200);
    const first = await api().post("/v1/auth/refresh").send({ refreshToken: user.refreshToken }).expect(200);
    assert.notEqual(first.body.refreshToken, user.refreshToken);

    // Replaying the original token looks like theft: every token from that login is revoked
    await api().post("/v1/auth/refresh").send({ refreshToken: user.refreshToken }).expect(401);
    await api().post("/v1/auth/refresh").send({ refreshToken: first.body.refreshToken }).expect(401);
    // ...but the user's other logins keep working
    await api().post("/v1/auth/refresh").send({ refreshToken: otherDevice.body.refreshToken }).expect(200);
  });

  it("logs out a refresh token", async () => {
    const user = await createUser();
    await api().post("/v1/auth/logout").send({ refreshToken: user.refreshToken }).expect(204);
    await api().post("/v1/auth/refresh").send({ refreshToken: user.refreshToken }).expect(401);
  });

  it("requires a valid access token for /me", async () => {
    await api().get("/v1/me").expect(401);
    await api().get("/v1/me").set("Authorization", "Bearer forged.token.value").expect(401);
    const user = await createUser();
    const me = await api().get("/v1/me").set(user.auth).expect(200);
    assertNoSecrets(me.body);
    assert.deepEqual(me.body.user.favorites, []);
  });
});

describe("social sign-in", () => {
  it("rejects Google tokens it can't verify", async () => {
    const res = await api().post("/v1/auth/oauth/google").send({ idToken: "forged" }).expect(401);
    assert.equal(res.body.code, "INVALID_OAUTH_TOKEN");
  });

  it("creates an account from a Spotify token Spotify vouches for", async () => {
    const fetchMock = stubFetch({
      "https://api.spotify.com/v1/me": (_url, init) =>
        init.headers.Authorization === "Bearer good-token"
          ? json({ id: "spotify-1", email: "listener@example.com", display_name: "Listener", images: [] })
          : json({ error: "bad token" }, 401),
    });
    try {
      await api().post("/v1/auth/oauth/spotify").send({ accessToken: "bad-token" }).expect(401);
      const first = await api().post("/v1/auth/oauth/spotify").send({ accessToken: "good-token" }).expect(200);
      const again = await api().post("/v1/auth/oauth/spotify").send({ accessToken: "good-token" }).expect(200);
      assert.equal(first.body.user.id, again.body.user.id);
      assert.equal(first.body.user.verified, true);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("re-links accounts that Spotify created before oauth_accounts existed", async () => {
    const { rows: [legacy] } = await pool.query(
      "INSERT INTO users (name, email, verified, provider) VALUES ('Old', 'old-spotify@example.com', true, 'spotify') RETURNING id"
    );
    const fetchMock = stubFetch({
      "https://api.spotify.com/v1/me": () => json({ id: "spotify-legacy", email: "old-spotify@example.com", display_name: "Old" }),
    });
    try {
      const res = await api().post("/v1/auth/oauth/spotify").send({ accessToken: "t" }).expect(200);
      assert.equal(res.body.user.id, legacy.id);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("won't attach a Spotify login to someone else's existing account by email", async () => {
    const victim = await createUser("victim@example.com");
    const fetchMock = stubFetch({
      "https://api.spotify.com/v1/me": () => json({ id: "attacker", email: victim.email, display_name: "A" }),
    });
    try {
      const res = await api().post("/v1/auth/oauth/spotify").send({ accessToken: "attacker-token" }).expect(409);
      assert.equal(res.body.code, "EMAIL_IN_USE");
    } finally {
      fetchMock.mock.restore();
    }
  });
});

describe("catalogue", () => {
  let artiste, release;
  before(async () => {
    artiste = await createUser("artiste@example.com");
    release = await seedRelease(artiste.user.id);
  });

  it("serves releases publicly without leaking the artiste's private fields", async () => {
    const res = await api().get(`/v1/playlists/${release.playlist.id}`).expect(200);
    assertNoSecrets(res.body);
    assert.deepEqual(Object.keys(res.body.artiste).sort(), ["display_picture_url", "id", "name"]);
    assert.equal(res.body.trackList[0].price, "0.01");
    assert.equal(res.body.user, null);
  });

  it("includes the caller's account when signed in", async () => {
    const res = await api().get(`/v1/playlists/${release.playlist.id}`).set(artiste.auth).expect(200);
    assert.equal(res.body.user.id, artiste.user.id);
  });

  it("returns tracks in one shape with the caller's favourite flag", async () => {
    const fan = await createUser();
    await api().post("/v1/favorites").set(fan.auth).send({ trackId: release.track.id }).expect(200);

    const anonymous = await api().get(`/v1/playlists/${release.playlist.id}`).expect(200);
    const signedIn = await api().get(`/v1/playlists/${release.playlist.id}`).set(fan.auth).expect(200);
    assert.equal(anonymous.body.trackList[0].favorite, false);
    assert.equal(signedIn.body.trackList[0].favorite, true);
    assert.equal(signedIn.body.trackList[0].album_title, "Album 100%");
    assert.equal(signedIn.body.trackList[0].owned, 0);

    const favorites = await api().get("/v1/me/favorites").set(fan.auth).expect(200);
    assert.deepEqual(favorites.body.tracks.map((t) => t.id), [release.track.id]);
    const library = await api().get("/v1/me/library").set(fan.auth).expect(200);
    assert.deepEqual(library.body.tracks, []);
    await api().get("/v1/me/library").expect(401);
  });

  it("lists releases for the marketplace, paged and filterable by type", async () => {
    const res = await api().get("/v1/playlists").expect(200);
    const listed = res.body.playlists.find((p) => p.id === release.playlist.id);
    assert.equal(listed.artiste_name, "Test User");
    assert.equal(listed.track_count, 1);
    assert.equal(listed.min_price, "0.01");

    await seedRelease(artiste.user.id, { album: "Second Release", song: "Other Song" });
    const firstPage = await api().get("/v1/playlists").query({ limit: 1 }).expect(200);
    assert.equal(firstPage.body.playlists.length, 1);
    assert.equal(firstPage.body.nextOffset, 1);
    const secondPage = await api().get("/v1/playlists").query({ limit: 1, offset: 1 }).expect(200);
    assert.notEqual(secondPage.body.playlists[0].id, firstPage.body.playlists[0].id);

    const singles = await api().get("/v1/playlists").query({ type: "Single" }).expect(200);
    assert.equal(singles.body.playlists.length, 0);
  });

  it("returns 404 for unknown releases and survives database errors", async () => {
    await api().get("/v1/playlists/999999").expect(404);
    // Larger than Postgres integer: the query throws, the server answers 500 and keeps running
    const res = await api().get("/v1/playlists/99999999999").expect(500);
    assert.equal(res.body.code, "INTERNAL");
    await api().get("/v1/playlists").expect(200);
  });

  it("searches with wildcards treated literally", async () => {
    const hit = await api().get("/v1/search").query({ q: "100%" }).expect(200);
    assert.equal(hit.body.tracks.length, 1);
    assert.deepEqual(hit.body.albums.map((a) => a.title), ["Album 100%"]);
    assert.deepEqual(hit.body.artistes.map((a) => a.name), ["Test User"]);
    const literalUnderscore = await api().get("/v1/search").query({ q: "Song_" }).expect(200);
    assert.equal(literalUnderscore.body.tracks.length, 1);
    const noWildcard = await api().get("/v1/search").query({ q: "Song%One" }).expect(200);
    assert.equal(noWildcard.body.tracks.length, 0);
    await api().get("/v1/search").expect(400);
  });

  it("lets only the artiste edit a track", async () => {
    const other = await createUser();
    const edit = { title: "Renamed", writers: "W2", producers: "P2", explicit: true };
    await api().patch(`/v1/tracks/${release.track.id}`).send(edit).expect(401);
    await api().patch(`/v1/tracks/${release.track.id}`).set(other.auth).send(edit).expect(403);
    const res = await api().patch(`/v1/tracks/${release.track.id}`).set(artiste.auth).send(edit).expect(200);
    assert.equal(res.body.track.title, "Renamed");
    // Legacy rows carry nulls that clients send back unchanged
    await api().patch(`/v1/tracks/${release.track.id}`).set(artiste.auth).send({ ...edit, featuredArtistes: null, explicit: null }).expect(200);
    await api().patch("/v1/tracks/999999").set(artiste.auth).send(edit).expect(404);
  });

  it("manages favourites for the signed-in user only, without duplicates", async () => {
    const fan = await createUser();
    await api().post("/v1/favorites").send({ trackId: release.track.id, userId: fan.user.id }).expect(401);

    await api().post("/v1/favorites").set(fan.auth).send({ trackId: release.track.id }).expect(200);
    const twice = await api().post("/v1/favorites").set(fan.auth).send({ trackId: release.track.id }).expect(200);
    assert.deepEqual(twice.body.user.favorites, [String(release.track.id)]);

    const removed = await api().delete(`/v1/favorites/${release.track.id}`).set(fan.auth).expect(200);
    assert.deepEqual(removed.body.user.favorites, []);
    await api().post("/v1/favorites").set(fan.auth).send({ trackId: 999999 }).expect(404);
  });
});

describe("uploads", () => {
  it("requires sign-in", async () => {
    await api().post("/v1/uploads?kind=image").attach("file", Buffer.from("x"), "a.png").expect(401);
  });

  it("pins files through the server and only lets the uploader unpin them", async () => {
    const cid = "QmTestCid1234567890abcdefghijklmnopqrstuvwxyzAB";
    const unpinned = [];
    const fetchMock = stubFetch({
      "https://api.pinata.cloud/pinning/pinFileToIPFS": () => json({ IpfsHash: cid }),
      "https://api.pinata.cloud/pinning/unpin/": (url) => {
        unpinned.push(String(url));
        return new Response(null, { status: 200 });
      },
    });
    try {
      const owner = await createUser();
      const stranger = await createUser();
      await api().post("/v1/uploads?kind=audio").set(owner.auth).attach("file", Buffer.from("png"), { filename: "a.png", contentType: "image/png" }).expect(400);

      const res = await api()
        .post("/v1/uploads?kind=image")
        .set(owner.auth)
        .attach("file", Buffer.from("png"), { filename: "a.png", contentType: "image/png" })
        .expect(201);
      assert.deepEqual(res.body, { cid, uri: `ipfs://${cid}`, url: `https://test.mypinata.cloud/ipfs/${cid}` });

      await api().delete(`/v1/uploads/${cid}`).set(stranger.auth).expect(404);
      await api().delete(`/v1/uploads/${cid}`).set(owner.auth).expect(204);
      assert.equal(unpinned.length, 1);
    } finally {
      fetchMock.mock.restore();
    }
  });
});

describe("error handling", () => {
  it("answers unknown routes and malformed JSON with JSON errors", async () => {
    const missing = await api().get("/v1/nope").expect(404);
    assert.equal(missing.body.code, "NOT_FOUND");
    const malformed = await api().post("/v1/auth/login").set("Content-Type", "application/json").send("{bad").expect(400);
    assert.equal(malformed.body.code, "BAD_REQUEST");
  });

  it("never sends mail containing anything but the expected code", () => {
    assert.ok(testOutbox.every((mail) => /^\d{6}$/.test(mail.code)));
  });
});
