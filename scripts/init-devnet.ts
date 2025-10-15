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

import {
  makeContractCall,
  broadcastTransaction,
  AnchorMode,
  PostConditionMode,
  bufferCV,
  uintCV,
  principalCV,
  stringUtf8CV,
} from '@stacks/transactions';
import { STACKS_DEVNET } from '@stacks/network';

// Devnet configuration
const network = STACKS_DEVNET;

// Devnet test account keys (from Devnet.toml)
const DEPLOYER_KEY = '753b7cc01a1a2e86221266a154af739463fce51219d97e4f856cd7200c3bd2a601';
const WALLET_1_KEY = '7287ba251d44a4d3fd9276c88ce34c5c52a038955511cccaf77e61068649c17801';
const WALLET_2_KEY = '530d9f61984c888536871c6573073bdfc0058896dc1adfe9a6a10dfacadc209101';

// Addresses
const DEPLOYER = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM';
const WALLET_1 = 'ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5';
const WALLET_2 = 'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG';

// Market IDs (generated from hash of question)
const MARKET_1_ID = Buffer.from('0505050505050505050505050505050505050505050505050505050505050505', 'hex');
const QUESTION_1_ID = Buffer.from('0101010101010101010101010101010101010101010101010101010101010101', 'hex');

// Condition ID for the market (computed from oracle + questionId)
const CONDITION_1_ID = Buffer.from('2b2b446d823ad0af28c8d1d5f8217eae4432ef117b759a32bfbe0b79f8613240', 'hex');
const PARENT_COLLECTION = Buffer.from('0000000000000000000000000000000000000000000000000000000000000000', 'hex');

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForTx(txid: string) {
  console.log(`   ⏳ TX: ${txid}`);
  await sleep(3000); // Wait for block confirmation
}

async function initializeQuestion(questionId: Buffer, question: string, reward: bigint) {
  const txOptions = {
    contractAddress: DEPLOYER,
    contractName: 'optimistic-oracle',
    functionName: 'initialize-question',
    functionArgs: [bufferCV(questionId), stringUtf8CV(question), uintCV(reward)],
    senderKey: DEPLOYER_KEY,
    network,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Allow,
  };

  const transaction = await makeContractCall(txOptions);
  const result = await broadcastTransaction({ transaction, network });

  if ('error' in result) {
    throw new Error(`Failed to initialize question: ${result.error} - ${result.reason}`);
  }

  return result.txid;
}

async function initializeMarket(marketId: Buffer, questionId: Buffer) {
  const txOptions = {
    contractAddress: DEPLOYER,
    contractName: 'oracle-adapter',
    functionName: 'initialize-market',
    functionArgs: [
      bufferCV(marketId),
      bufferCV(questionId),
      principalCV(`${DEPLOYER}.optimistic-oracle`)
    ],
    senderKey: DEPLOYER_KEY,
    network,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Allow,
  };

  const transaction = await makeContractCall(txOptions);
  const result = await broadcastTransaction({ transaction, network });

  if ('error' in result) {
    throw new Error(`Failed to initialize market: ${result.error} - ${result.reason}`);
  }

  return result.txid;
}

async function splitPosition(senderKey: string, _sender: string, amount: bigint) {
  const txOptions = {
    contractAddress: DEPLOYER,
    contractName: 'conditional-tokens',
    functionName: 'split-position',
    functionArgs: [
      principalCV(`${DEPLOYER}.sbtc-token`),
      bufferCV(PARENT_COLLECTION),
      bufferCV(CONDITION_1_ID),
      uintCV(amount),
    ],
    senderKey,
    network,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Allow,
  };

  const transaction = await makeContractCall(txOptions);
  const result = await broadcastTransaction({ transaction, network });

  if ('error' in result) {
    throw new Error(`Failed to split position: ${result.error} - ${result.reason}`);
  }

  return result.txid;
}

async function main() {
  console.log('\n🚀 StackCast Devnet Initialization\n');
  console.log(`📡 Network: ${network.client.baseUrl}`);
  console.log(`💰 Wallets already have 1000 sBTC each (from Devnet.toml)\n`);

  try {
    // Step 1: Create demo market
    console.log('📊 Step 1: Creating demo market');
    console.log('   Market: "Will ETH hit $10k by Dec 31, 2025?"');

    let txid = await initializeQuestion(
      QUESTION_1_ID,
      'Will ETH hit $10k by Dec 31, 2025?',
      1_000_000_000n // 1000 sBTC reward
    );
    await waitForTx(txid);
    console.log('   ✅ Question initialized in optimistic-oracle');

    txid = await initializeMarket(MARKET_1_ID, QUESTION_1_ID);
    await waitForTx(txid);
    console.log('   ✅ Market initialized in oracle-adapter');

    // Step 2: Create conditional tokens (split collateral)
    console.log('\n🎫 Step 2: Creating conditional token positions');
    console.log('   Splitting sBTC into YES/NO outcome tokens...');

    txid = await splitPosition(WALLET_1_KEY, WALLET_1, 100_000_000n); // 100 sBTC
    await waitForTx(txid);
    console.log('   ✅ wallet_1: Split 100 sBTC → 100 YES + 100 NO tokens');

    txid = await splitPosition(WALLET_2_KEY, WALLET_2, 100_000_000n); // 100 sBTC
    await waitForTx(txid);
    console.log('   ✅ wallet_2: Split 100 sBTC → 100 YES + 100 NO tokens');

    console.log('\n✅ Devnet initialization complete!\n');
    console.log('📝 What was set up:');
    console.log('   • 1 prediction market: ETH price');
    console.log('   • 2 wallets with conditional tokens (YES/NO)');
    console.log('   • Ready for trading via exchange\n');

    console.log('🌐 Next steps:');
    console.log('   1. Start backend:  cd ../server && npm run dev');
    console.log('   2. Start frontend: cd ../web && npm run dev');
    console.log('   3. Open browser:   http://localhost:5173');
    console.log('   4. Connect wallet and trade!\n');

  } catch (error: any) {
    console.error('\n❌ Error:', error.message || error);
    console.error('\n💡 Troubleshooting:');
    console.error('   • Is devnet running? (clarinet devnet start)');
    console.error('   • Did contracts deploy? (check devnet logs)');
    console.error('   • Try waiting 30s after devnet starts\n');
    process.exit(1);
  }
}

main();
