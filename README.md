# Nodewave API

Express 5 + Postgres API for the Nodewave web and mobile apps. It owns authentication,
the music catalogue, IPFS uploads, wallet linking, and an indexer that mirrors the
NodeWave contract's events into Postgres.

## Setup

```bash
cp .env.example .env      # fill in the values
npm install
npm run migrate           # applies src/db/migrations/*.sql
npm run dev
```

After changing the contract, recompile it in `../eth-server` and run `npm run sync-abi`.

## Tests

```bash
createdb nodewave_test    # once
npm test
```

The on-chain tests in `test/chain.test.js` need a local node (`npx hardhat node` in
`../eth-server`) and are skipped when none is running.

## How clients authenticate

Every protected route takes `Authorization: Bearer <accessToken>`. Access tokens last
15 minutes; exchange the refresh token at `POST /v1/auth/refresh` for a new pair
(refresh tokens rotate on every use).

| Sign-in method | Endpoint |
| --- | --- |
| Email + password | `POST /v1/auth/login` |
| Code from the verification email | `POST /v1/auth/verify-email` |
| Google ID token (web or native) | `POST /v1/auth/oauth/google` |
| Spotify access token | `POST /v1/auth/oauth/spotify` |

Each returns `{ user, accessToken, accessTokenExpiresAt, refreshToken }`.

The Next.js app keeps these tokens inside its NextAuth session; a React Native app
should keep them in secure storage (e.g. `expo-secure-store`).

## Minting a release

1. Link the minting wallet: `POST /v1/wallets/nonce`, sign a Sign-In With Ethereum
   message containing the nonce, then `POST /v1/wallets { message, signature }`.
2. Upload the cover: `POST /v1/uploads?kind=image` (multipart field `file`).
3. Upload each track: `POST /v1/uploads/track` (multipart `file`, `title`, `coverUri`,
   `genre`, `explicit`). Returns `{ audioId, uri, previewUrl }`.
4. Call `mintCollection` with the returned `uri`s.
5. `POST /v1/playlists { txHash, type, title, ..., tracks: [{ ..., audioId }] }`. The API
   reads token IDs and prices from the transaction and checks each token was minted
   with its upload's metadata.

## Token-gated audio

Full tracks never go to IPFS. They're stored in a private Supabase Storage bucket when
`SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are set, otherwise in `STORAGE_DIR` (the API's
disk). They're streamed only through `GET /v1/tracks/:id/stream`, which checks the caller
owns a copy and returns a link that expires after `MEDIA_URL_TTL_SECONDS`. With Supabase,
that link redirects to a Supabase signed URL that expires at the same time.

Everything public (covers, the 30-second previews ffmpeg cuts at upload, and token
metadata) goes to Pinata when `PINATA_JWT` and `PINATA_GATEWAY` are set, otherwise to
`STORAGE_DIR/public`, served at `/v1/media/public`. In production, `API_PUBLIC_URL` must
be the API's public address, and anything kept in `STORAGE_DIR` must be on a persistent
disk (hosts like Render's free tier wipe it, so use Supabase and Pinata there).

ffmpeg comes with the `ffmpeg-static` package. If npm blocked its install script,
run `npm approve-scripts ffmpeg-static` and reinstall.
