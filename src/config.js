import "dotenv/config";
import path from "node:path";
import { z } from "zod";

const csv = z
  .string()
  .default("")
  .transform((value) => value.split(",").map((item) => item.trim()).filter(Boolean));

const optionalString = z
  .string()
  .optional()
  .transform((value) => value || undefined);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(3001),
  TRUST_PROXY: z.coerce.number().int().default(0), // number of proxies in front of the API (for rate limiting by IP)

  DATABASE_HOST: z.string().default("localhost"),
  DATABASE_PORT: z.coerce.number().int().default(5432),
  DATABASE_USER: z.string(),
  DATABASE_PASSWORD: z.string().default(""),
  DATABASE_NAME: z.string(),

  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().default(15 * 60),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().default(30),
  REFRESH_REUSE_GRACE_SECONDS: z.coerce.number().int().min(0).default(30),
  SALTROUNDS: z.coerce.number().int().min(10).default(12),

  CORS_ORIGINS: csv, // browser origins allowed to call the API; native apps don't send Origin
  CLIENTURL: z.url().default("http://localhost:3000"),

  MAILHOST: z.string().optional(),
  MAILPORT: z.coerce.number().int().default(587),
  MAILUSER: z.string().optional(),
  MAILPASS: z.string().optional(),
  MAIL_FROM: z.string().default("Nodewave <no-reply@nodewave.com>"),

  // Every OAuth client ID whose Google ID tokens we accept (web, iOS, Android)
  GOOGLE_CLIENT_IDS: csv,
  GOOGLECLIENTID: optionalString,

  // Public files (covers, previews, metadata) go to Pinata when configured, else to local disk
  PINATA_JWT: optionalString,
  PINATA_GATEWAY: optionalString, // e.g. my-gateway.mypinata.cloud
  MAX_UPLOAD_MB: z.coerce.number().default(50),

  // Full tracks are stored here and only ever streamed to owners
  STORAGE_DIR: z.string().default("./storage"),
  // How browsers reach this API (used in signed media links and locally served files)
  API_PUBLIC_URL: optionalString,
  MEDIA_URL_TTL_SECONDS: z.coerce.number().int().min(60).default(60 * 60),
  PREVIEW_SECONDS: z.coerce.number().int().min(5).max(120).default(30),

  RPC_URL: optionalString,
  CONTRACT_ADDRESS: optionalString,
  INDEXER_START_BLOCK: z.coerce.bigint().default(0n),
  INDEXER_CONFIRMATIONS: z.coerce.bigint().default(1n),
  INDEXER_POLL_MS: z.coerce.number().int().default(5000),
  INDEXER_BATCH_BLOCKS: z.coerce.bigint().default(2000n),

  // Domains allowed in Sign-In With Ethereum messages (web host, app scheme)
  SIWE_DOMAINS: csv,
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  ...env,
  isProd: env.NODE_ENV === "production",
  isTest: env.NODE_ENV === "test",
  CORS_ORIGINS: env.CORS_ORIGINS.length ? env.CORS_ORIGINS : [env.CLIENTURL],
  GOOGLE_CLIENT_IDS: env.GOOGLE_CLIENT_IDS.length
    ? env.GOOGLE_CLIENT_IDS
    : [env.GOOGLECLIENTID].filter(Boolean),
  SIWE_DOMAINS: env.SIWE_DOMAINS.length ? env.SIWE_DOMAINS : [new URL(env.CLIENTURL).host],
  CONTRACT_ADDRESS: env.CONTRACT_ADDRESS?.toLowerCase(),
  API_PUBLIC_URL: (env.API_PUBLIC_URL ?? `http://localhost:${env.PORT}`).replace(/\/$/, ""),
  STORAGE_DIR: path.resolve(env.STORAGE_DIR),
  pinataEnabled: Boolean(env.PINATA_JWT && env.PINATA_GATEWAY),
  chainEnabled: Boolean(env.RPC_URL && env.CONTRACT_ADDRESS),
};
