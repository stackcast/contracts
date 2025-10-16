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
const MARKETS = [
  {
    id: Buffer.alloc(32, 1),
    question: "Will ETH hit $10k by Dec 31, 2025?",
    reward: 1_000_000_000n, // 1000 sBTC
  },
  {
    id: Buffer.alloc(32, 2),
    question: "Will Bitcoin reach $150k by end of 2025?",
    reward: 1_500_000_000n, // 1500 sBTC
  },
  {
    id: Buffer.alloc(32, 3),
    question: "Will Apple stock hit $250 by July 2025?",
    reward: 800_000_000n, // 800 sBTC
  },
  {
    id: Buffer.alloc(32, 4),
    question: "Will a major AI lab release AGI by 2026?",
    reward: 2_000_000_000n, // 2000 sBTC
  },
  {
    id: Buffer.alloc(32, 5),
    question: "Will Trump win the 2028 US Presidential Election?",
    reward: 1_200_000_000n, // 1200 sBTC
  },
  {
    id: Buffer.alloc(32, 6),
    question: "Will Tesla's stock price exceed $500 in 2025?",
    reward: 900_000_000n, // 900 sBTC
  },
  {
    id: Buffer.alloc(32, 7),
    question: "Will the Fed cut interest rates below 3% by Dec 2025?",
    reward: 1_100_000_000n, // 1100 sBTC
  },
  {
    id: Buffer.alloc(32, 8),
    question: "Will Nvidia market cap exceed $5 trillion in 2025?",
    reward: 1_300_000_000n, // 1300 sBTC
  },
  {
    id: Buffer.alloc(32, 9),
    question: "Will there be a manned mission to Mars by 2030?",
    reward: 2_500_000_000n, // 2500 sBTC
  },
  {
    id: Buffer.alloc(32, 10),
    question: "Will Solana price surpass $500 by end of 2025?",
    reward: 1_000_000_000n, // 1000 sBTC
  },
  {
    id: Buffer.alloc(32, 11),
    question: "Will global inflation drop below 2% by 2026?",
    reward: 700_000_000n, // 700 sBTC
  },
  {
    id: Buffer.alloc(32, 12),
    question: "Will a quantum computer break RSA-2048 by 2027?",
    reward: 3_000_000_000n, // 3000 sBTC
  },
];

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
  console.log(`📊 Initializing ${MARKETS.length} prediction markets...\n`);

  const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";
  const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "";

  const conditionIds: string[] = [];

  try {
    // Loop through all markets
    for (let i = 0; i < MARKETS.length; i++) {
      const market = MARKETS[i];
      console.log(`\n📈 Market ${i + 1}/${MARKETS.length}: "${market.question}"`);
      console.log(`   Market ID: ${toHex(market.id)}`);

      // Step 1: Initialize market on-chain
      let txid = await initializeMarket(
        market.id,
        market.question,
        market.reward
      );
      await waitForTx(txid);
      console.log("   ✅ Market initialized in oracle-adapter");

      // Step 2: Get the condition ID from contract
      const conditionId = await getConditionId(market.id);
      conditionIds.push(conditionId);
      console.log(`   ✅ Condition ID: ${conditionId}`);

      // Step 3: Initialize market in backend server
      if (ADMIN_API_KEY) {
        try {
          const response = await fetch(`${SERVER_URL}/api/markets`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-API-Key": ADMIN_API_KEY,
            },
            body: JSON.stringify({
              question: market.question,
              creator: DEPLOYER,
              conditionId: conditionId,
            }),
          });

          if (response.ok) {
            console.log("   ✅ Market created in backend server");
          } else {
            const errorText = await response.text();
            console.log(
              `   ⚠️  Could not create market in backend: ${response.status} ${errorText}`
            );
          }
        } catch (error: any) {
          if (i === 0) {
            console.log(
              `   ⚠️  Backend server not running: ${error.message}`
            );
          }
        }
      } else if (i === 0) {
        console.log("   ⚠️  ADMIN_API_KEY not set, skipping backend initialization");
      }
    }

    console.log("\n✅ Devnet initialization complete!\n");
    console.log("📝 What was set up:");
    console.log(`   • ${MARKETS.length} prediction markets created`);
    console.log("   • All markets registered in oracle and oracle-adapter");
    console.log("   • Ready for users to split positions and trade\n");

    console.log("🌐 Next steps:");
    console.log("   1. Split positions using condition IDs from above");
    console.log("   2. Start backend:  cd ../server && bun dev");
    console.log("   3. Start frontend: cd ../web && bun dev");
    console.log("   4. Open browser:   http://localhost:5173");
    console.log("   5. Connect wallet and trade!\n");

    console.log("📋 Split position command example (first market):");
    console.log(`   clarinet console --exec "(contract-call? .conditional-tokens split-position u100000000 ${conditionIds[0]})"`);
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
