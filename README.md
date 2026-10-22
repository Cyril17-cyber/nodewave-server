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
2. Upload the cover and audio: `POST /v1/uploads?kind=image|audio` (multipart field `file`).
3. Call `mintCollection` on the contract.
4. `POST /v1/playlists { txHash, type, title, ..., tracks }`. The API reads token IDs
   and prices from the transaction's events.
