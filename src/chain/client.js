import fs from "node:fs";
import { createPublicClient, http } from "viem";
import { config } from "../config.js";

export const nodewaveAbi = JSON.parse(fs.readFileSync(new URL("./NodeWave.abi.json", import.meta.url), "utf8"));

/** viem client for the configured RPC, or null when chain features are disabled. */
export const publicClient = config.RPC_URL ? createPublicClient({ transport: http(config.RPC_URL) }) : null;
