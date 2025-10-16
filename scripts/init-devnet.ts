#!/usr/bin/env tsx
/**
 * StackCast Environment Initialization Script
 *
 * Sets up demo markets and initial trading positions on devnet or testnet.
 * Wallets already have sBTC from Devnet.toml config (1000 sBTC each) for devnet.
 *
 * USAGE:
 *   For devnet:
 *   1. Start devnet: clarinet devnet start
 *   2. Wait for contracts to deploy (~30 seconds)
 *   3. Run: npx tsx scripts/init-devnet.ts
 *
 *   For testnet:
 *   1. Deploy to testnet: clarinet deployments apply -p deployments/default.testnet-plan.yaml
 *   2. Run: ENVIRONMENT=prod npx tsx scripts/init-devnet.ts
 */

import { config } from "dotenv";
import * as readline from "readline";

// Determine environment from ENV variable or prompt
const envArg = process.env.ENVIRONMENT;
let selectedEnv: "dev" | "prod" = "dev";

if (envArg === "prod" || envArg === "production" || envArg === "testnet") {
  selectedEnv = "prod";
  config({ path: ".env.prod" }); // Load .env.prod file
} else if (
  envArg === "dev" ||
  envArg === "devnet" ||
  envArg === "development"
) {
  selectedEnv = "dev";
  config(); // Load .env file
} else if (!envArg) {
  // Will prompt user below
  config(); // Default to .env for now
}

import { STACKS_DEVNET, STACKS_TESTNET } from "@stacks/network";
import {
  AnchorMode,
  PostConditionMode,
  broadcastTransaction,
  bufferCV,
  cvToValue,
  fetchCallReadOnlyFunction,
  makeContractCall,
  stringUtf8CV,
  uintCV,
} from "@stacks/transactions";

// Prompt user for environment if not specified
async function promptEnvironment(): Promise<"dev" | "prod"> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(
      "\n🔧 Select environment:\n  1) Devnet (local)\n  2) Testnet (production)\n\nEnter choice (1 or 2): ",
      (answer) => {
        rl.close();
        if (answer.trim() === "2") {
          console.log("✅ Selected: Testnet (production)\n");
          resolve("prod");
        } else {
          console.log("✅ Selected: Devnet (local)\n");
          resolve("dev");
        }
      }
    );
  });
}

// Prompt user for deployment options
async function promptDeploymentOptions(): Promise<"all" | "hackathon"> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(
      "\n🎯 What would you like to deploy?\n  1) All demo markets\n  2) Hackathon prediction (fun!) 🎉\n\nEnter choice (1 or 2): ",
      (answer) => {
        rl.close();
        if (answer.trim() === "2") {
          console.log("✅ Selected: Hackathon prediction only 🚀\n");
          resolve("hackathon");
        } else {
          console.log("✅ Selected: All demo markets\n");
          resolve("all");
        }
      }
    );
  });
}

// If no environment specified, prompt user
if (!envArg) {
  selectedEnv = await promptEnvironment();
  if (selectedEnv === "prod") {
    config({ path: ".env.prod", override: true });
  }
}

// Network configuration based on environment
const network = selectedEnv === "prod" ? STACKS_TESTNET : STACKS_DEVNET;
const DEPLOYER =
  selectedEnv === "prod"
    ? "ST3MFDEP2CKXVHYHW0TSAAD430R95YTVBW7QHZN9F"
    : "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";
const TX_WAIT_TIME = selectedEnv === "prod" ? 30000 : 5000; // 30s for testnet, 5s for devnet

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

// Deployer key from environment variables
const DEPLOYER_KEY = mustEnv("DEPLOYER_KEY");

// Market data
const MARKETS = [
  {
    id: Buffer.alloc(32, 1),
    question: "Will ETH hit $10k by Dec 31, 2025?",
    reward: 25_000_000n, // 25 sBTC
  },
  {
    id: Buffer.alloc(32, 2),
    question: "Will Bitcoin reach $150k by end of 2025?",
    reward: 30_000_000n, // 30 sBTC
  },
  {
    id: Buffer.alloc(32, 3),
    question: "Will Apple stock hit $250 by July 2025?",
    reward: 20_000_000n, // 20 sBTC
  },
  {
    id: Buffer.alloc(32, 4),
    question: "Will a major AI lab release AGI by 2026?",
    reward: 50_000_000n, // 50 sBTC (controversial, needs higher reward)
  },
  {
    id: Buffer.alloc(32, 5),
    question: "Will Trump win the 2028 US Presidential Election?",
    reward: 40_000_000n, // 40 sBTC
  },
  {
    id: Buffer.alloc(32, 6),
    question: "Will Tesla's stock price exceed $500 in 2025?",
    reward: 20_000_000n, // 20 sBTC
  },
  {
    id: Buffer.alloc(32, 7),
    question: "Will the Fed cut interest rates below 3% by Dec 2025?",
    reward: 25_000_000n, // 25 sBTC
  },
  {
    id: Buffer.alloc(32, 8),
    question: "Will Nvidia market cap exceed $5 trillion in 2025?",
    reward: 25_000_000n, // 25 sBTC
  },
  {
    id: Buffer.alloc(32, 9),
    question: "Will there be a manned mission to Mars by 2030?",
    reward: 50_000_000n, // 50 sBTC (long-term, harder to verify)
  },
  {
    id: Buffer.alloc(32, 10),
    question: "Will Solana price surpass $500 by end of 2025?",
    reward: 20_000_000n, // 20 sBTC
  },
  {
    id: Buffer.alloc(32, 11),
    question: "Will global inflation drop below 2% by 2026?",
    reward: 15_000_000n, // 15 sBTC
  },
  {
    id: Buffer.alloc(32, 12),
    question: "Will a quantum computer break RSA-2048 by 2027?",
    reward: 100_000_000n, // 100 sBTC (highly technical, max reward)
  },
];

// 🎉 Special hackathon market (for fun!)
const HACKATHON_MARKET = {
  id: Buffer.alloc(32, 99), // Special ID 99
  question: "Will StackCast win the Stacks Vibe Coding Hackathon? 🚀",
  reward: 1000_000_000n, // 1000 sBTC (HUGE reward for the memes)
};

// Helper to convert buffer to hex string with 0x prefix
function toHex(buf: Buffer): string {
  return "0x" + buf.toString("hex");
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTx(txid: string) {
  console.log(`   ⏳ TX: ${txid}`);
  await sleep(TX_WAIT_TIME); // Wait for block confirmation
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

    if (value && value.value && typeof value.value === "string") {
      return value.value;
    }

    throw new Error("Could not extract condition ID from response");
  } catch (error: any) {
    throw new Error(`Failed to get condition ID: ${error.message}`);
  }
}

async function main() {
  const envName =
    selectedEnv === "prod" ? "Testnet (Production)" : "Devnet (Local)";
  console.log(`\n🚀 StackCast ${envName} Initialization\n`);
  console.log(`📡 Network: ${network.client.baseUrl}`);
  if (selectedEnv === "dev") {
    console.log(`💰 Wallets already have 1000 sBTC each (from Devnet.toml)\n`);
  }

  // Ask what to deploy
  const deploymentChoice = await promptDeploymentOptions();

  // Select markets to deploy
  const marketsToInit =
    deploymentChoice === "hackathon" ? [HACKATHON_MARKET] : MARKETS;

  console.log(`📊 Initializing ${marketsToInit.length} prediction market${marketsToInit.length > 1 ? "s" : ""}...\n`);

  const SERVER_URL =
    process.env.SERVER_URL ||
    (selectedEnv === "prod"
      ? "https://api.stackcast.xyz"
      : "http://localhost:3000");
  const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "";

  const conditionIds: string[] = [];

  try {
    // Loop through selected markets
    for (let i = 0; i < marketsToInit.length; i++) {
      const market = marketsToInit[i];
      console.log(
        `\n📈 Market ${i + 1}/${marketsToInit.length}: "${market.question}"`
      );
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
            console.log(`   ⚠️  Backend server not running: ${error.message}`);
          }
        }
      } else if (i === 0) {
        console.log(
          "   ⚠️  ADMIN_API_KEY not set, skipping backend initialization"
        );
      }
    }

    console.log("\n✅ Initialization complete!\n");
    console.log("📝 What was set up:");
    console.log(`   • ${marketsToInit.length} prediction market${marketsToInit.length > 1 ? "s" : ""} created`);
    console.log("   • All markets registered in oracle and oracle-adapter");
    console.log("   • Ready for users to split positions and trade\n");

    if (deploymentChoice === "hackathon") {
      console.log("🎉 Hackathon market deployed!");
      console.log('   Question: "Will StackCast win the Stacks Vibe Coding Hackathon? 🚀"');
      console.log("   Reward: 1000 sBTC (for the memes)\n");
    }

    console.log("🌐 Next steps:");
    console.log("   1. Split positions using condition IDs from above");
    console.log("   2. Start backend:  cd ../server && bun dev");
    console.log("   3. Start frontend: cd ../web && bun dev");
    console.log("   4. Open browser:   http://localhost:5173");
    console.log("   5. Connect wallet and trade!\n");

    console.log("📋 Split position command example (first market):");
    console.log(
      `   clarinet console --exec "(contract-call? .conditional-tokens split-position u100000000 ${conditionIds[0]})"`
    );
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
