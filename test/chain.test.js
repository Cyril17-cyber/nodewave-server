// End-to-end against a local Hardhat node: `npx hardhat node` in ../eth-server.
// Skipped when no node is reachable.
import { setup } from "./helpers.js";
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
    const hash = await wallet(account).writeContract({ address, abi, functionName, args, value });
    await publicClient.waitForTransactionReceipt({ hash });
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

  const releaseBody = (txHash, count, type = "Album") => ({
    txHash,
    type,
    title: "Debut",
    genre: "Afrobeats",
    cover: "https://test.mypinata.cloud/ipfs/cover",
    tracks: Array.from({ length: count }, (_, i) => ({ title: `Track ${i + 1}`, writers: "W", producers: "P" })),
  });

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

  describe("releases and indexing", () => {
    let artist, buyer, release;
    const [artistUris, prices] = [["ipfs://song-a", "ipfs://song-b"], [parseEther("0.01"), parseEther("0.02")]];

    before(async () => {
      artist = await ctx.createUser();
      buyer = await ctx.createUser();
      assert.equal((await linkWallet(artist, accounts[4])).res.status, 201);
      assert.equal((await linkWallet(buyer, accounts[5])).res.status, 201);
    });

    it("registers a release using token ids and prices from the chain", async () => {
      const txHash = await mintCollection(accounts[4], artistUris, prices);
      const res = await ctx.api().post("/v1/playlists").set(artist.auth).send(releaseBody(txHash, 2)).expect(201);
      release = res.body;
      assert.deepEqual(release.trackList.map((t) => t.price), ["0.01", "0.02"]);
      const onChainIds = await Promise.all(
        artistUris.map(async (_, i) => (await publicClient.readContract({ address, abi, functionName: "idMarketItem", args: [BigInt(release.trackList[i].token_id)] }))[1])
      );
      assert.deepEqual(onChainIds, artistUris);

      const again = await ctx.api().post("/v1/playlists").set(artist.auth).send(releaseBody(txHash, 2)).expect(409);
      assert.equal(again.body.code, "ALREADY_REGISTERED");
    });

    it("refuses mints from a wallet the caller hasn't linked, and mismatched descriptions", async () => {
      const txHash = await mintCollection(accounts[4], ["ipfs://song-c"], [parseEther("0.01")]);
      const notMine = await ctx.api().post("/v1/playlists").set(buyer.auth).send(releaseBody(txHash, 1, "Single")).expect(403);
      assert.equal(notMine.body.code, "WALLET_NOT_LINKED");
      const mismatch = await ctx.api().post("/v1/playlists").set(artist.auth).send(releaseBody(txHash, 2, "EP")).expect(400);
      assert.equal(mismatch.body.code, "TRACK_MISMATCH");
      await ctx.api().post("/v1/playlists").set(artist.auth).send(releaseBody(txHash, 2, "Single")).expect(400);
      await ctx.api().post("/v1/playlists").set(artist.auth).send(releaseBody(txHash, 1, "Single")).expect(201);
    });

    it("indexes purchases and price changes", async () => {
      const [first] = release.trackList;
      await write(accounts[5], "buyToken", [BigInt(first.token_id), 1n], parseEther("0.01"));
      await write(accounts[4], "updateItemPrice", [BigInt(first.token_id), parseEther("0.05")]);

      assert.ok((await syncOnce()) > 0);
      assert.equal(await syncOnce(), 0, "re-running the indexer applies nothing twice");

      const me = await ctx.api().get("/v1/me").set(buyer.auth).expect(200);
      assert.deepEqual(me.body.user.purchased_songs, [String(first.id)]);

      const { rows } = await ctx.pool.query("SELECT supply FROM chain_tokens WHERE token_id = $1", [first.token_id]);
      assert.equal(rows[0].supply, "4");

      const playlist = await ctx.api().get(`/v1/playlists/${release.playlist.id}`).set(buyer.auth).expect(200);
      assert.equal(playlist.body.trackList[0].price, "0.05");
      assert.equal(playlist.body.trackList[0].uri, "ipfs://song-a");
      assert.equal(playlist.body.trackList[0].supply, "4");
      // Ownership comes from indexed transfers to the buyer's linked wallet
      assert.deepEqual(playlist.body.trackList.map((t) => t.owned), [1, 0]);

      const library = await ctx.api().get("/v1/me/library").set(buyer.auth).expect(200);
      assert.deepEqual(library.body.tracks.map((t) => t.id), [first.id]);
      // Artistes keep one copy of every track they mint
      const artistLibrary = await ctx.api().get("/v1/me/library").set(artist.auth).expect(200);
      assert.equal(artistLibrary.body.tracks.length, 3);
    });
  });
});
