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

import { STACKS_DEVNET } from "@stacks/network";
import {
  AnchorMode,
  PostConditionMode,
  broadcastTransaction,
  bufferCV,
  makeContractCall,
  stringUtf8CV,
  uintCV,
} from "@stacks/transactions";
import { generateCompositeId, generateId, toHex } from "./id-utils.js";

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
const WALLET_1_KEY = mustEnv("WALLET_1_KEY");
const WALLET_2_KEY = mustEnv("WALLET_2_KEY");

// Addresses
const DEPLOYER = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";
const WALLET_1 = "ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5";
const WALLET_2 = "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG";

// Market data
const QUESTION_1_TEXT = "Will ETH hit $10k by Dec 31, 2025?";
const ORACLE_CONTRACT = `${DEPLOYER}.optimistic-oracle`;

// Generate IDs deterministically from question data
const QUESTION_1_ID = generateId("question", [QUESTION_1_TEXT, DEPLOYER]);
const MARKET_1_ID = generateId("market", [QUESTION_1_TEXT, ORACLE_CONTRACT]);
const CONDITION_1_ID = generateCompositeId([ORACLE_CONTRACT, QUESTION_1_ID, 2]); // 2 outcomes (YES/NO)
const PARENT_COLLECTION = Buffer.alloc(32); // All zeros

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
) {
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

async function splitPosition(
  senderKey: string,
  _sender: string,
  amount: bigint
) {
  const txOptions = {
    contractAddress: DEPLOYER,
    contractName: "conditional-tokens",
    functionName: "split-position",
    functionArgs: [uintCV(amount), bufferCV(CONDITION_1_ID)],
    senderKey,
    network,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Allow,
  };

  const transaction = await makeContractCall(txOptions);
  const result = await broadcastTransaction({ transaction, network });

  if ("error" in result) {
    throw new Error(
      `Failed to split position: ${result.error} - ${result.reason}`
    );
  }

  return result.txid;
}

async function main() {
  console.log("\n🚀 StackCast Devnet Initialization\n");
  console.log(`📡 Network: ${network.client.baseUrl}`);
  console.log(`💰 Wallets already have 1000 sBTC each (from Devnet.toml)\n`);

  console.log("🔑 Generated IDs (deterministic):");
  console.log(`   Question ID:  ${toHex(QUESTION_1_ID)}`);
  console.log(`   Market ID:    ${toHex(MARKET_1_ID)}`);
  console.log(`   Condition ID: ${toHex(CONDITION_1_ID)}\n`);

  try {
    // Step 1: Create demo market
    console.log("📊 Step 1: Creating demo market");
    console.log(`   Market: "${QUESTION_1_TEXT}"`);

    let txid = await initializeMarket(
      MARKET_1_ID,
      QUESTION_1_TEXT,
      1_000_000_000n // 1000 sBTC reward
    );
    await waitForTx(txid);
    console.log("   ✅ Market initialized in oracle-adapter");

    // Step 2: Create conditional tokens (split collateral)
    console.log("\n🎫 Step 2: Creating conditional token positions");
    console.log("   Splitting sBTC into YES/NO outcome tokens...");

    txid = await splitPosition(WALLET_1_KEY, WALLET_1, 100_000_000n); // 100 sBTC
    await waitForTx(txid);
    console.log("   ✅ wallet_1: Split 100 sBTC → 100 YES + 100 NO tokens");

    txid = await splitPosition(WALLET_2_KEY, WALLET_2, 100_000_000n); // 100 sBTC
    await waitForTx(txid);
    console.log("   ✅ wallet_2: Split 100 sBTC → 100 YES + 100 NO tokens");

    // Step 3: Initialize market in backend server
    console.log("\n🖥️  Step 3: Initializing market in backend server");
    const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";

    try {
      const response = await fetch(`${SERVER_URL}/api/markets`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          question: QUESTION_1_TEXT,
          creator: DEPLOYER,
          conditionId: toHex(CONDITION_1_ID),
        }),
      });

      if (response.ok) {
        const data = await response.json();
        console.log("   ✅ Market created in backend server");
        console.log(`   Market ID: ${data.market?.marketId}`);
      } else {
        console.log(
          "   ⚠️  Could not reach backend server (this is OK if it's not running yet)"
        );
        console.log(
          "   You'll need to manually create the market by POSTing to /api/markets"
        );
      }
    } catch (error) {
      console.log(
        "   ⚠️  Backend server not running (start it with: cd ../server && bun dev)"
      );
      console.log(
        "   Market will need to be created manually once server is running"
      );
    }

    console.log("\n✅ Devnet initialization complete!\n");
    console.log("📝 What was set up:");
    console.log("   • 1 prediction market: ETH price");
    console.log("   • 2 wallets with conditional tokens (YES/NO)");
    console.log("   • Backend market initialized (if server was running)");
    console.log("   • Ready for trading via exchange\n");

    console.log("🌐 Next steps:");
    console.log("   1. Start backend:  cd ../server && bun dev");
    console.log("   2. Start frontend: cd ../web && bun dev");
    console.log("   3. Open browser:   http://localhost:5173");
    console.log("   4. Connect wallet and trade!\n");
  } catch (error: any) {
    console.error("\n❌ Error:", error.message || error);
    console.error("\nFull error:", JSON.stringify(error, null, 2));
    console.error("\n💡 Troubleshooting:");
    console.error("   • Is devnet running? (clarinet devnet start)");
    console.error("   • Did contracts deploy? (check devnet logs)");
    console.error("   • Try waiting 30s after devnet starts\n");
    process.exit(1);
  }
}

main();
