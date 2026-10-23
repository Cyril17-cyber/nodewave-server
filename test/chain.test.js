// End-to-end against a local Hardhat node: `npx hardhat node` in ../eth-server.
// Skipped when no node is reachable.
import { apiPath, makeTone, setup } from "./helpers.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, it } from "node:test";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, parseEther } from "viem";
import { createSiweMessage } from "viem/siwe";

const RPC = process.env.TEST_RPC_URL || "http://127.0.0.1:8545";
const chainId = await fetch(RPC, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }),
})
  .then((r) => r.json())
  .then((r) => Number(r.result))
  .catch(() => null);

describe("on-chain flows", { skip: chainId ? false : `no Ethereum node at ${RPC}` }, () => {
  const artifact = JSON.parse(
    fs.readFileSync(new URL("../../eth-server/artifacts/contracts/NodeWave.sol/NodeWave.json", import.meta.url), "utf8")
  );
  const { abi, bytecode } = artifact;
  let ctx, publicClient, wallet, address, accounts, syncOnce;

  const write = async (account, functionName, args, value) => {
    // Simulate first so a revert fails the test with the contract error instead of passing silently
    const { request } = await publicClient.simulateContract({ account, address, abi, functionName, args, value });
    const hash = await wallet(account).writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success", `${functionName} reverted`);
    return hash;
  };

  async function mintCollection(account, uris, prices, amount = 5n) {
    const fee = await publicClient.readContract({ address, abi, functionName: "collectionListingPrice" });
    return write(account, "mintCollection", [amount, uris, prices], fee * BigInt(uris.length) * amount);
  }

  async function linkWallet(user, account, overrides = {}) {
    const { body } = await ctx.api().post("/v1/wallets/nonce").set(user.auth).expect(200);
    const message = createSiweMessage({
      domain: "localhost:3000",
      address: getAddress(account),
      statement: "Link this wallet to your Nodewave account",
      uri: "http://localhost:3000",
      version: "1",
      chainId,
      nonce: body.nonce,
      ...overrides,
    });
    const signature = await wallet(account).signMessage({ message });
    return { message, signature, res: await ctx.api().post("/v1/wallets").set(user.auth).send({ message, signature }) };
  }

  const releaseBody = (txHash, uploads, type = "Album") => ({
    txHash,
    type,
    title: "Debut",
    genre: "Afrobeats",
    cover: "https://test.mypinata.cloud/ipfs/cover",
    tracks: uploads.map((u, i) => ({ title: `Track ${i + 1}`, writers: "W", producers: "P", audioId: u.audioId })),
  });

  let toneFrequency = 200;
  /** Uploads `count` distinct tracks; returns [{ audioId, uri, previewUrl }]. */
  async function uploadTracks(user, count) {
    const uploads = [];
    for (let i = 0; i < count; i++) {
      const res = await ctx
        .api()
        .post("/v1/uploads/track")
        .set(user.auth)
        .field("title", `Track ${i + 1}`)
        .field("coverUri", "https://test.mypinata.cloud/ipfs/cover")
        .attach("file", makeTone({ seconds: 6, frequency: (toneFrequency += 37) }), {
          filename: "t.mp3",
          contentType: "audio/mpeg",
        })
        .expect(201);
      uploads.push(res.body);
    }
    return uploads;
  }

  before(async () => {
    const chain = defineChain({
      id: chainId,
      name: "Local",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [RPC] } },
    });
    publicClient = createPublicClient({ chain, transport: http(RPC) });
    wallet = (account) => createWalletClient({ account, chain, transport: http(RPC) });
    accounts = await publicClient.request({ method: "eth_accounts" });

    const deployHash = await wallet(accounts[0]).deployContract({ abi, bytecode, args: [accounts[0]] });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
    address = receipt.contractAddress;

    process.env.RPC_URL = RPC;
    process.env.CONTRACT_ADDRESS = address;
    process.env.INDEXER_START_BLOCK = String(receipt.blockNumber);
    process.env.INDEXER_CONFIRMATIONS = "1";
    process.env.PINATA_JWT = "";
    ctx = await setup();
    ({ syncOnce } = await import("../src/indexer/indexer.js"));
  });
  after(() => ctx?.pool.end());

  describe("wallet linking", () => {
    it("links a wallet proven by signature, once, to one account", async () => {
      const [, artistWallet] = accounts;
      const artist = await ctx.createUser();
      const linked = await linkWallet(artist, artistWallet);
      assert.equal(linked.res.status, 201);
      assert.deepEqual(linked.res.body.user.wallets, [artistWallet.toLowerCase()]);

      // The nonce is single use, so a captured message can't be replayed
      const replay = await ctx.api().post("/v1/wallets").set(artist.auth).send({ message: linked.message, signature: linked.signature });
      assert.equal(replay.status, 400);

      const other = await ctx.createUser();
      const stolen = await linkWallet(other, artistWallet);
      assert.equal(stolen.res.status, 409);
      assert.equal(stolen.res.body.code, "WALLET_IN_USE");
    });

    it("rejects messages for another site", async () => {
      const user = await ctx.createUser();
      const { res } = await linkWallet(user, accounts[3], { domain: "evil.example" });
      assert.equal(res.status, 400);
    });
  });

  describe("releases, resales and trades", () => {
    let artist, buyer, collector, release, single, albumUploads;
    const prices = [parseEther("0.01"), parseEther("0.02")];

    before(async () => {
      artist = await ctx.createUser();
      buyer = await ctx.createUser();
      collector = await ctx.createUser();
      assert.equal((await linkWallet(artist, accounts[4])).res.status, 201);
      assert.equal((await linkWallet(buyer, accounts[5])).res.status, 201);
      assert.equal((await linkWallet(collector, accounts[6])).res.status, 201);
    });

    it("mints with the uploaded metadata and registers the release from chain data", async () => {
      albumUploads = await uploadTracks(artist, 2);
      // Without Pinata, metadata is served by the API itself and points at the public preview
      const metadata = await ctx.api().get(apiPath(albumUploads[0].uri)).expect(200);
      assert.equal(metadata.body.animation_url, albumUploads[0].previewUrl);

      const txHash = await mintCollection(accounts[4], albumUploads.map((u) => u.uri), prices);
      const res = await ctx.api().post("/v1/playlists").set(artist.auth).send(releaseBody(txHash, albumUploads)).expect(201);
      release = res.body;
      assert.deepEqual(release.trackList.map((t) => t.price), ["0.01", "0.02"]);
      assert.deepEqual(release.trackList.map((t) => t.gated), [true, true]);

      const again = await ctx.api().post("/v1/playlists").set(artist.auth).send(releaseBody(txHash, albumUploads)).expect(409);
      assert.equal(again.body.code, "ALREADY_REGISTERED");
    });

    it("refuses mints from unlinked wallets, wrong track counts, and audio that doesn't match the token", async () => {
      const uploads = await uploadTracks(artist, 2);
      const txHash = await mintCollection(accounts[4], [uploads[0].uri], [parseEther("0.01")]);

      const notMine = await ctx.api().post("/v1/playlists").set(buyer.auth).send(releaseBody(txHash, [uploads[0]], "Single")).expect(403);
      assert.equal(notMine.body.code, "WALLET_NOT_LINKED");
      const count = await ctx.api().post("/v1/playlists").set(artist.auth).send(releaseBody(txHash, uploads, "EP")).expect(400);
      assert.equal(count.body.code, "TRACK_MISMATCH");
      // The token was minted with upload 0's metadata, so upload 1's audio can't be attached to it
      const swapped = await ctx.api().post("/v1/playlists").set(artist.auth).send(releaseBody(txHash, [uploads[1]], "Single")).expect(400);
      assert.equal(swapped.body.code, "AUDIO_MISMATCH");

      const ok = await ctx.api().post("/v1/playlists").set(artist.auth).send(releaseBody(txHash, [uploads[0]], "Single")).expect(201);
      single = ok.body.trackList[0];
    });

    it("indexes purchases and price changes, and unlocks the full track for the buyer", async () => {
      const [first] = release.trackList;
      await ctx.api().get(`/v1/tracks/${first.id}/stream`).set(buyer.auth).expect(403);

      await write(accounts[5], "buyToken", [BigInt(first.token_id), 1n], parseEther("0.01"));
      await write(accounts[4], "updateItemPrice", [BigInt(first.token_id), parseEther("0.05")]);
      assert.ok((await syncOnce()) > 0);
      assert.equal(await syncOnce(), 0, "re-running the indexer applies nothing twice");

      const me = await ctx.api().get("/v1/me").set(buyer.auth).expect(200);
      assert.deepEqual(me.body.user.purchased_songs, [String(first.id)]);

      const playlist = await ctx.api().get(`/v1/playlists/${release.playlist.id}`).set(buyer.auth).expect(200);
      assert.equal(playlist.body.trackList[0].price, "0.05");
      assert.equal(playlist.body.trackList[0].supply, "4");
      assert.deepEqual(playlist.body.trackList.map((t) => t.owned), [1, 0]);

      const stream = await ctx.api().get(`/v1/tracks/${first.id}/stream`).set(buyer.auth).expect(200);
      await ctx.api().get(apiPath(stream.body.url)).expect(200);

      const artistLibrary = await ctx.api().get("/v1/me/library").set(artist.auth).expect(200);
      assert.equal(artistLibrary.body.tracks.length, 3, "artistes keep a copy of every track they mint");
    });

    it("lists a copy for resale and sells it to another collector", async () => {
      const [, second] = release.trackList;
      // The artiste resells their own copy of track 2
      await write(accounts[4], "listForResale", [BigInt(second.token_id), 1n, parseEther("0.03")]);
      await syncOnce();

      const listings = await ctx.api().get(`/v1/tracks/${second.id}/listings`).set(collector.auth).expect(200);
      assert.equal(listings.body.listings.length, 1);
      const [listing] = listings.body.listings;
      assert.equal(listing.price, "0.03");
      assert.equal(listing.mine, false);
      const mine = await ctx.api().get("/v1/me/listings").set(artist.auth).expect(200);
      assert.deepEqual(mine.body.listings.map((l) => l.listing_id), [listing.listing_id]);

      await write(accounts[6], "buyResale", [BigInt(listing.listing_id), 1n], parseEther("0.03"));
      await syncOnce();

      const after = await ctx.api().get(`/v1/tracks/${second.id}/listings`).expect(200);
      assert.equal(after.body.listings.length, 0);
      const library = await ctx.api().get("/v1/me/library").set(collector.auth).expect(200);
      assert.deepEqual(library.body.tracks.map((t) => t.id), [second.id]);
      const { rows } = await ctx.pool.query("SELECT kind FROM purchases WHERE token_id = $1", [second.token_id]);
      assert.deepEqual(rows.map((r) => r.kind), ["resale"]);
    });

    it("tracks a trade offer from proposal to acceptance", async () => {
      const [first, second] = release.trackList;
      const holders = await ctx.api().get(`/v1/tracks/${second.id}/holders`).set(buyer.auth).expect(200);
      const collectorHolder = holders.body.holders.find((h) => h.user_id === collector.user.id);
      assert.ok(collectorHolder, "the collector shows up as a holder of track 2");

      // Buyer offers their copy of track 1 for the collector's copy of track 2
      const tradeFee = await publicClient.readContract({ address, abi, functionName: "tradeFee" });
      await write(accounts[5], "createTradeOffer", [collectorHolder.address, BigInt(first.token_id), 1n, BigInt(second.token_id), 1n], tradeFee);
      await syncOnce();

      const incoming = await ctx.api().get("/v1/me/trades").set(collector.auth).expect(200);
      const [offer] = incoming.body.trades;
      assert.equal(offer.status, "open");
      assert.equal(offer.incoming, true);
      assert.equal(offer.offered_track.id, first.id);
      assert.equal(offer.requested_track.id, second.id);
      const outgoing = await ctx.api().get("/v1/me/trades").set(buyer.auth).expect(200);
      assert.equal(outgoing.body.trades[0].incoming, false);

      await write(accounts[6], "acceptTradeOffer", [BigInt(offer.trade_id)]);
      await syncOnce();

      const done = await ctx.api().get("/v1/me/trades").set(collector.auth).expect(200);
      assert.equal(done.body.trades[0].status, "accepted");
      const buyerLibrary = await ctx.api().get("/v1/me/library").set(buyer.auth).expect(200);
      assert.deepEqual(buyerLibrary.body.tracks.map((t) => t.id), [second.id]);
      const collectorLibrary = await ctx.api().get("/v1/me/library").set(collector.auth).expect(200);
      assert.deepEqual(collectorLibrary.body.tracks.map((t) => t.id), [first.id]);
      assert.ok(single, "single from the earlier test is registered");
    });
  });
});
