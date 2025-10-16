#!/usr/bin/env tsx
/**
 * StackCast Devnet Initialization Script
 *
 * Sets up demo markets and initial trading positions on devnet.
 * Wallets already have sBTC from Devnet.toml config (1000 sBTC each).
 *
 * USAGE:
 *   1. Start devnet: clarinet devnet start
 *   2. Wait for contracts to deploy (~30 seconds)
 *   3. Run: npx tsx scripts/init-devnet.ts
 */

import { config } from "dotenv";
config(); // Load .env file

import { STACKS_DEVNET } from "@stacks/network";
import {
  AnchorMode,
  PostConditionMode,
  broadcastTransaction,
  bufferCV,
  makeContractCall,
  stringUtf8CV,
  uintCV,
  fetchCallReadOnlyFunction,
  cvToValue,
} from "@stacks/transactions";

// Devnet configuration
const network = STACKS_DEVNET;

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

// Devnet test account keys (from environment variables)
const DEPLOYER_KEY = mustEnv("DEPLOYER_KEY");

// Addresses
const DEPLOYER = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";

// Market data
const QUESTION_1_TEXT = "Will ETH hit $10k by Dec 31, 2025?";

// Generate IDs - market-id and question-id are the same in oracle-adapter.clar
// Using a simple 32-byte buffer filled with 1s for the first market
const MARKET_1_ID = Buffer.alloc(32, 1);

// Helper to convert buffer to hex string with 0x prefix
function toHex(buf: Buffer): string {
  return "0x" + buf.toString("hex");
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTx(txid: string) {
  console.log(`   ⏳ TX: ${txid}`);
  await sleep(5000); // Wait for block confirmation
}

async function initializeMarket(
  marketId: Buffer,
  question: string,
  reward: bigint
): Promise<string> {
  const txOptions = {
    contractAddress: DEPLOYER,
    contractName: "oracle-adapter",
    functionName: "initialize-market",
    functionArgs: [bufferCV(marketId), stringUtf8CV(question), uintCV(reward)],
    senderKey: DEPLOYER_KEY,
    network,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Allow,
  };

  const transaction = await makeContractCall(txOptions);
  const result = await broadcastTransaction({ transaction, network });

  if ("error" in result) {
    throw new Error(
      `Failed to initialize market: ${result.error} - ${result.reason}`
    );
  }

  return result.txid;
}

async function getConditionId(marketId: Buffer): Promise<string> {
  try {
    const result = await fetchCallReadOnlyFunction({
      network,
      contractAddress: DEPLOYER,
      contractName: "oracle-adapter",
      functionName: "get-condition-id",
      functionArgs: [bufferCV(marketId)],
      senderAddress: DEPLOYER,
    });

    const value = cvToValue(result);

    if (value && value.value && typeof value.value === 'string') {
      return value.value;
    }

    throw new Error("Could not extract condition ID from response");
  } catch (error: any) {
    throw new Error(`Failed to get condition ID: ${error.message}`);
  }
}

async function main() {
  console.log("\n🚀 StackCast Devnet Initialization\n");
  console.log(`📡 Network: ${network.client.baseUrl}`);
  console.log(`💰 Wallets already have 1000 sBTC each (from Devnet.toml)\n`);

  console.log("🔑 Generated IDs:");
  console.log(`   Market ID:    ${toHex(MARKET_1_ID)}`);

  try {
    // Step 1: Create demo market
    console.log("\n📊 Step 1: Creating demo market");
    console.log(`   Market: "${QUESTION_1_TEXT}"`);

    let txid = await initializeMarket(
      MARKET_1_ID,
      QUESTION_1_TEXT,
      1_000_000_000n // 1000 sBTC reward
    );
    await waitForTx(txid);
    console.log("   ✅ Market initialized in oracle-adapter");

    // Step 2: Get the actual condition ID from the contract
    console.log("\n🔍 Step 2: Reading condition ID from contract");
    const conditionId = await getConditionId(MARKET_1_ID);
    console.log(`   ✅ Condition ID: ${conditionId}`);

    // Step 3: Initialize market in backend server
    console.log("\n🖥️  Step 3: Initializing market in backend server");
    const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";
    const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "";

    if (ADMIN_API_KEY) {
      try {
        const response = await fetch(`${SERVER_URL}/api/markets`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": ADMIN_API_KEY,
          },
          body: JSON.stringify({
            question: QUESTION_1_TEXT,
            creator: DEPLOYER,
            conditionId: conditionId,
          }),
        });

        if (response.ok) {
          const data = await response.json();
          console.log("   ✅ Market created in backend server");
          console.log(`   Market data:`, data);
        } else {
          const errorText = await response.text();
          console.log(
            `   ⚠️  Could not create market in backend: ${response.status} ${errorText}`
          );
        }
      } catch (error: any) {
        console.log(
          `   ⚠️  Backend server not running: ${error.message}`
        );
      }
    } else {
      console.log("   ⚠️  ADMIN_API_KEY not set, skipping backend initialization");
    }

    console.log("\n✅ Devnet initialization complete!\n");
    console.log("📝 What was set up:");
    console.log("   • 1 prediction market: ETH price");
    console.log("   • Market registered in oracle and oracle-adapter");
    console.log(`   • Condition ID: ${conditionId}`);
    console.log("   • Ready for users to split positions and trade\n");

    console.log("🌐 Next steps:");
    console.log(`   1. Split positions using condition ID: ${conditionId}`);
    console.log("   2. Start backend:  cd ../server && bun dev");
    console.log("   3. Start frontend: cd ../web && bun dev");
    console.log("   4. Open browser:   http://localhost:5173");
    console.log("   5. Connect wallet and trade!\n");

    console.log("📋 Split position command example:");
    console.log(`   clarinet console --exec "(contract-call? .conditional-tokens split-position u100000000 ${conditionId})"`);
    console.log("");
  } catch (error: any) {
    console.error("\n❌ Error:", error.message || error);
    console.error("\n💡 Troubleshooting:");
    console.error("   • Is devnet running? (clarinet devnet start)");
    console.error("   • Did contracts deploy? (check devnet logs)");
    console.error("   • Are environment variables set? (check .env file)");
    console.error("   • Try waiting 30s after devnet starts\n");
    process.exit(1);
  }
}

main();
