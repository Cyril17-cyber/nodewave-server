// Copies the NodeWave ABI from the Hardhat build into the server.
// Run after `npx hardhat compile` in ../eth-server: npm run sync-abi
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const artifact = path.resolve(root, "../eth-server/artifacts/contracts/NodeWave.sol/NodeWave.json");
const target = path.join(root, "src/chain/NodeWave.abi.json");

const { abi } = JSON.parse(await fs.readFile(artifact, "utf8"));
await fs.writeFile(target, JSON.stringify(abi, null, 2) + "\n");
console.log(`Wrote ${abi.length} ABI entries to ${path.relative(root, target)}`);
