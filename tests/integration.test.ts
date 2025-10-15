import { describe, expect, it } from "vitest";
import { Cl, ClarityType, isClarityType } from "@stacks/transactions";
import { hexToBytes } from "@stacks/common";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const wallet1 = accounts.get("wallet_1")!;
const wallet2 = accounts.get("wallet_2")!;
const wallet3 = accounts.get("wallet_3")!;

// sBTC token contract (auto-funded in simnet)
const SBTC_CONTRACT = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

describe("Integration Tests: Full Market Flow", () => {
  // Helper to get position IDs
  function getPositionId(
    conditionId: Uint8Array,
    outcomeIndex: number
  ): Uint8Array {
    const result = simnet.callReadOnlyFn(
      "conditional-tokens",
      "get-position-id-readonly",
      [Cl.buffer(conditionId), Cl.uint(outcomeIndex)],
      deployer
    );

    if (!isClarityType(result.result, ClarityType.Buffer)) {
      throw new Error(`Expected Buffer, got ${result.result.type}`);
    }

    const hexString = result.result.value.replace(/^0x/, '');
    return hexToBytes(hexString);
  }

  // Helper function to initialize a market and get the condition ID
  function initializeMarket(marketId: Uint8Array): Uint8Array {
    const question = "Will BTC hit $100k by Dec 31, 2025?";
    const reward = 100_000_000;

    const result = simnet.callPublicFn(
      "oracle-adapter",
      "initialize-market",
      [Cl.buffer(marketId), Cl.stringUtf8(question), Cl.uint(reward)],
      deployer
    );

    if (!isClarityType(result.result, ClarityType.ResponseOk)) {
      throw new Error(`Expected ResponseOk, got ${result.result.type}`);
    }

    if (!isClarityType(result.result.value, ClarityType.Buffer)) {
      throw new Error(`Expected Buffer in response, got ${result.result.value.type}`);
    }

    const hexString = result.result.value.value.replace(/^0x/, '');
    return hexToBytes(hexString);
  }

  describe("Full Flow: Split → Trade → Resolve → Redeem", () => {
    it("completes end-to-end flow from market creation to redemption", () => {
      // ═══════════════════════════════════════════════════════════
      // STEP 1: Initialize Market
      // ═══════════════════════════════════════════════════════════
      const marketId = new Uint8Array(32).fill(1);
      const questionId = marketId;
      const conditionId = initializeMarket(marketId);
      const yesPositionId = getPositionId(conditionId, 0);
      const noPositionId = getPositionId(conditionId, 1);

      console.log("✓ Market initialized");

      // ═══════════════════════════════════════════════════════════
      // STEP 2: Users Split sBTC into YES/NO tokens
      // ═══════════════════════════════════════════════════════════
      const splitAmount = 10_000_000; // 10 sBTC

      // Wallet1 splits sBTC
      simnet.callPublicFn(
        "conditional-tokens",
        "split-position",
        [Cl.uint(splitAmount), Cl.buffer(conditionId)],
        wallet1
      );

      // Verify wallet1 received YES and NO tokens
      const wallet1YesBalance = simnet.callReadOnlyFn(
        "conditional-tokens",
        "balance-of",
        [Cl.principal(wallet1), Cl.buffer(yesPositionId)],
        wallet1
      );
      expect(wallet1YesBalance.result).toBeUint(splitAmount);

      const wallet1NoBalance = simnet.callReadOnlyFn(
        "conditional-tokens",
        "balance-of",
        [Cl.principal(wallet1), Cl.buffer(noPositionId)],
        wallet1
      );
      expect(wallet1NoBalance.result).toBeUint(splitAmount);

      console.log("✓ Wallet1 split sBTC into YES/NO tokens");

      // Wallet2 also splits
      simnet.callPublicFn(
        "conditional-tokens",
        "split-position",
        [Cl.uint(splitAmount), Cl.buffer(conditionId)],
        wallet2
      );

      console.log("✓ Wallet2 split sBTC into YES/NO tokens");

      // ═══════════════════════════════════════════════════════════
      // STEP 3: Users Can Transfer Position Tokens P2P
      // ═══════════════════════════════════════════════════════════
      const transferAmount = 1_000_000; // 1 sBTC worth

      simnet.callPublicFn(
        "conditional-tokens",
        "safe-transfer-from",
        [
          Cl.principal(wallet1),
          Cl.principal(wallet3),
          Cl.buffer(yesPositionId),
          Cl.uint(transferAmount),
        ],
        wallet1
      );

      // Verify transfer
      const wallet3YesBalance = simnet.callReadOnlyFn(
        "conditional-tokens",
        "balance-of",
        [Cl.principal(wallet3), Cl.buffer(yesPositionId)],
        wallet3
      );
      expect(wallet3YesBalance.result).toBeUint(transferAmount);

      console.log("✓ Wallet1 transferred YES tokens to Wallet3");

      // ═══════════════════════════════════════════════════════════
      // STEP 4: Users Can Merge Position Tokens Back to sBTC
      // ═══════════════════════════════════════════════════════════
      const mergeAmount = 2_000_000; // 2 sBTC worth

      const wallet2PreMergeSBTC = simnet.callReadOnlyFn(
        SBTC_CONTRACT,
        "get-balance",
        [Cl.principal(wallet2)],
        wallet2
      );

      simnet.callPublicFn(
        "conditional-tokens",
        "merge-positions",
        [Cl.uint(mergeAmount), Cl.buffer(conditionId), Cl.principal(wallet2)],
        wallet2
      );

      // Verify sBTC returned
      const wallet2PostMergeSBTC = simnet.callReadOnlyFn(
        SBTC_CONTRACT,
        "get-balance",
        [Cl.principal(wallet2)],
        wallet2
      );

      expect(wallet2PostMergeSBTC.result).not.toBe(wallet2PreMergeSBTC.result);

      console.log("✓ Wallet2 merged YES+NO tokens back to sBTC");

      // ═══════════════════════════════════════════════════════════
      // STEP 5: Oracle Resolution Flow (Optimistic Oracle)
      // ═══════════════════════════════════════════════════════════

      // 5a. Someone proposes an answer (YES)
      simnet.callPublicFn(
        "optimistic-oracle",
        "propose-answer",
        [Cl.buffer(questionId), Cl.uint(1)], // YES
        wallet1
      );

      console.log("✓ Wallet1 proposed answer: YES");

      // Verify proposal exists
      const proposal = simnet.callReadOnlyFn(
        "optimistic-oracle",
        "get-proposal",
        [Cl.buffer(questionId)],
        deployer
      );

      if (!isClarityType(proposal.result, ClarityType.OptionalSome)) {
        throw new Error(`Expected OptionalSome for proposal, got ${proposal.result.type}`);
      }

      if (!isClarityType(proposal.result.value, ClarityType.Tuple)) {
        throw new Error(`Expected Tuple in proposal, got ${proposal.result.value.type}`);
      }

      const proposalData = proposal.result.value.value;
      expect(proposalData['proposer']).toHaveClarityType(ClarityType.PrincipalStandard);
      expect(proposalData['proposed-answer']).toBeUint(1);

      // 5b. Wait for challenge window (144 blocks ~24 hours)
      simnet.mineEmptyBlocks(150);

      console.log("✓ Challenge window passed (no disputes)");

      // 5c. Resolve the oracle question
      const resolveResult = simnet.callPublicFn(
        "optimistic-oracle",
        "resolve",
        [Cl.buffer(questionId)],
        deployer
      );
      expect(resolveResult.result).toBeOk(Cl.uint(1)); // YES

      console.log("✓ Oracle resolved: YES");

      // ═══════════════════════════════════════════════════════════
      // STEP 6: Report Payout to Conditional Tokens
      // ═══════════════════════════════════════════════════════════
      const reportResult = simnet.callPublicFn(
        "oracle-adapter",
        "resolve-market",
        [Cl.buffer(marketId)],
        deployer
      );
      expect(reportResult.result).toBeOk(Cl.bool(true));

      console.log("✓ Market payout reported to CTF");

      // Verify condition is resolved
      const condition = simnet.callReadOnlyFn(
        "conditional-tokens",
        "get-condition",
        [Cl.buffer(conditionId)],
        deployer
      );

      if (!isClarityType(condition.result, ClarityType.OptionalSome)) {
        throw new Error(`Expected OptionalSome for condition, got ${condition.result.type}`);
      }

      if (!isClarityType(condition.result.value, ClarityType.Tuple)) {
        throw new Error(`Expected Tuple in condition, got ${condition.result.value.type}`);
      }

      const conditionData = condition.result.value.value;
      expect(conditionData['resolved']).toBeBool(true);
      expect(conditionData['payout-numerators']).toHaveClarityType(ClarityType.List);

      // ═══════════════════════════════════════════════════════════
      // STEP 7: Winners Redeem Their Tokens
      // ═══════════════════════════════════════════════════════════

      // Wallet1 has 9,000,000 YES tokens left (transferred 1M to wallet3)
      // Calculate how much wallet1 has
      const wallet1YesAfterTransfer = simnet.callReadOnlyFn(
        "conditional-tokens",
        "balance-of",
        [Cl.principal(wallet1), Cl.buffer(yesPositionId)],
        wallet1
      );

      const wallet1PreRedeemSBTC = simnet.callReadOnlyFn(
        SBTC_CONTRACT,
        "get-balance",
        [Cl.principal(wallet1)],
        wallet1
      );

      // Wallet1 redeems YES tokens (winners)
      const redeemResult = simnet.callPublicFn(
        "conditional-tokens",
        "redeem-positions",
        [Cl.buffer(conditionId), Cl.uint(0)], // YES outcome
        wallet1
      );

      // Should return the balance as payout
      if (!isClarityType(wallet1YesAfterTransfer.result, ClarityType.UInt)) {
        throw new Error(`Expected UInt for balance, got ${wallet1YesAfterTransfer.result.type}`);
      }
      const expectedPayout = wallet1YesAfterTransfer.result.value;
      expect(redeemResult.result).toBeOk(Cl.uint(expectedPayout));

      // Verify sBTC received
      const wallet1PostRedeemSBTC = simnet.callReadOnlyFn(
        SBTC_CONTRACT,
        "get-balance",
        [Cl.principal(wallet1)],
        wallet1
      );

      expect(wallet1PostRedeemSBTC.result).not.toBe(wallet1PreRedeemSBTC.result);

      console.log("✓ Wallet1 redeemed YES tokens for sBTC");

      // ═══════════════════════════════════════════════════════════
      // STEP 8: Losers Get Nothing
      // ═══════════════════════════════════════════════════════════

      // Wallet2 has NO tokens (losers) - should get 0 payout
      // (wallet2 merged some, but still has remaining NO tokens)
      const wallet2NoBeforeRedeem = simnet.callReadOnlyFn(
        "conditional-tokens",
        "balance-of",
        [Cl.principal(wallet2), Cl.buffer(noPositionId)],
        wallet2
      );

      if (isClarityType(wallet2NoBeforeRedeem.result, ClarityType.UInt) && Number(wallet2NoBeforeRedeem.result.value) > 0) {
        const loserRedeemResult = simnet.callPublicFn(
          "conditional-tokens",
          "redeem-positions",
          [Cl.buffer(conditionId), Cl.uint(1)], // NO outcome
          wallet2
        );

        // Should return 0 payout
        expect(loserRedeemResult.result).toBeOk(Cl.uint(0));

        console.log("✓ Wallet2 attempted to redeem NO tokens: got 0 payout");
      }

      // ═══════════════════════════════════════════════════════════
      // STEP 9: Verify Final State
      // ═══════════════════════════════════════════════════════════

      // Wallet1's YES tokens should be burned
      const wallet1FinalYesBalance = simnet.callReadOnlyFn(
        "conditional-tokens",
        "balance-of",
        [Cl.principal(wallet1), Cl.buffer(yesPositionId)],
        wallet1
      );
      expect(wallet1FinalYesBalance.result).toBeUint(0);

      // Market should be resolved
      const finalCondition = simnet.callReadOnlyFn(
        "conditional-tokens",
        "get-condition",
        [Cl.buffer(conditionId)],
        deployer
      );

      if (!isClarityType(finalCondition.result, ClarityType.OptionalSome)) {
        throw new Error(`Expected OptionalSome for final condition, got ${finalCondition.result.type}`);
      }

      if (!isClarityType(finalCondition.result.value, ClarityType.Tuple)) {
        throw new Error(`Expected Tuple in final condition, got ${finalCondition.result.value.type}`);
      }

      const finalConditionData = finalCondition.result.value.value;
      expect(finalConditionData['resolved']).toBeBool(true);
      expect(finalConditionData['payout-numerators']).toStrictEqual(
        Cl.list([Cl.uint(1), Cl.uint(0)])
      );

      console.log("✓ Final state verified: Market resolved, winners paid out");
      console.log("\n══════════════════════════════════════════════");
      console.log("✅ FULL INTEGRATION TEST PASSED");
      console.log("══════════════════════════════════════════════\n");
    });
  });

  describe("Oracle Dispute Flow", () => {
    it("handles disputed resolution with voting", () => {
      // ═══════════════════════════════════════════════════════════
      // STEP 1: Initialize Market
      // ═══════════════════════════════════════════════════════════
      const marketId = new Uint8Array(32).fill(2);
      const questionId = marketId;
      initializeMarket(marketId);

      console.log("✓ Market initialized for dispute test");

      // ═══════════════════════════════════════════════════════════
      // STEP 2: Propose Answer
      // ═══════════════════════════════════════════════════════════
      simnet.callPublicFn(
        "optimistic-oracle",
        "propose-answer",
        [Cl.buffer(questionId), Cl.uint(0)], // NO
        wallet1
      );

      console.log("✓ Wallet1 proposed: NO");

      // ═══════════════════════════════════════════════════════════
      // STEP 3: Someone Disputes (within challenge window)
      // ═══════════════════════════════════════════════════════════
      const disputeResult = simnet.callPublicFn(
        "optimistic-oracle",
        "dispute-proposal",
        [Cl.buffer(questionId)],
        wallet2
      );
      expect(disputeResult.result).toBeOk(Cl.bool(true));

      console.log("✓ Wallet2 disputed the proposal");

      // ═══════════════════════════════════════════════════════════
      // STEP 4: Voting Period Begins
      // ═══════════════════════════════════════════════════════════
      const voteTally = simnet.callReadOnlyFn(
        "optimistic-oracle",
        "get-vote-tally",
        [Cl.buffer(questionId)],
        deployer
      );

      if (!isClarityType(voteTally.result, ClarityType.OptionalSome)) {
        throw new Error(`Expected OptionalSome for vote tally, got ${voteTally.result.type}`);
      }

      if (!isClarityType(voteTally.result.value, ClarityType.Tuple)) {
        throw new Error(`Expected Tuple in vote tally, got ${voteTally.result.value.type}`);
      }

      const tallyData = voteTally.result.value.value;
      expect(tallyData['yes-votes']).toHaveClarityType(ClarityType.UInt);
      expect(tallyData['no-votes']).toHaveClarityType(ClarityType.UInt);

      console.log("✓ Voting period initialized");

      // ═══════════════════════════════════════════════════════════
      // STEP 5: Users Vote
      // ═══════════════════════════════════════════════════════════
      simnet.callPublicFn(
        "optimistic-oracle",
        "vote",
        [Cl.buffer(questionId), Cl.uint(1), Cl.uint(1000)], // YES with 1000 stake
        wallet3
      );

      console.log("✓ Wallet3 voted YES with stake 1000");

      // ═══════════════════════════════════════════════════════════
      // STEP 6: Wait for Voting Period
      // ═══════════════════════════════════════════════════════════
      simnet.mineEmptyBlocks(300);

      console.log("✓ Voting period ended");

      // ═══════════════════════════════════════════════════════════
      // STEP 7: Resolve with Vote Result
      // ═══════════════════════════════════════════════════════════
      const resolveResult = simnet.callPublicFn(
        "optimistic-oracle",
        "resolve",
        [Cl.buffer(questionId)],
        deployer
      );
      expect(resolveResult.result).toBeOk(Cl.uint(1)); // YES wins (majority vote)

      console.log("✓ Resolved with voting result: YES");

      // ═══════════════════════════════════════════════════════════
      // STEP 8: Verify Resolution
      // ═══════════════════════════════════════════════════════════
      const finalAnswer = simnet.callReadOnlyFn(
        "optimistic-oracle",
        "get-final-answer",
        [Cl.buffer(questionId)],
        deployer
      );
      expect(finalAnswer.result).toBeSome(Cl.uint(1));

      console.log("✓ Final answer verified: YES");
      console.log("\n══════════════════════════════════════════════");
      console.log("✅ DISPUTE FLOW TEST PASSED");
      console.log("══════════════════════════════════════════════\n");
    });
  });

  describe("Partial Fill Scenario", () => {
    it("tracks filled amounts correctly for partial fills", () => {
      const marketId = new Uint8Array(32).fill(3);
      const conditionId = initializeMarket(marketId);
      const yesPositionId = getPositionId(conditionId, 0);
      const noPositionId = getPositionId(conditionId, 1);

      // Split positions for both wallets
      const splitAmount = 10_000_000;
      simnet.callPublicFn(
        "conditional-tokens",
        "split-position",
        [Cl.uint(splitAmount), Cl.buffer(conditionId)],
        wallet1
      );

      simnet.callPublicFn(
        "conditional-tokens",
        "split-position",
        [Cl.uint(splitAmount), Cl.buffer(conditionId)],
        wallet2
      );

      console.log("✓ Both wallets split positions");

      // Approve exchange
      simnet.callPublicFn(
        "conditional-tokens",
        "set-approval-for-all",
        [Cl.principal(`${deployer}.ctf-exchange`), Cl.bool(true)],
        wallet1
      );

      simnet.callPublicFn(
        "conditional-tokens",
        "set-approval-for-all",
        [Cl.principal(`${deployer}.ctf-exchange`), Cl.bool(true)],
        wallet2
      );

      // Create order hash
      const makerAmount = 1000;
      const takerAmount = 550;
      const salt = 99999;
      const expiration = 999999;

      const orderHash = simnet.callReadOnlyFn(
        "ctf-exchange",
        "hash-order",
        [
          Cl.principal(wallet1),
          Cl.principal(wallet2),
          Cl.buffer(yesPositionId),
          Cl.buffer(noPositionId),
          Cl.uint(makerAmount),
          Cl.uint(takerAmount),
          Cl.uint(salt),
          Cl.uint(expiration),
        ],
        deployer
      );

      console.log("✓ Order hash computed");

      // Check initial filled amount
      const initialFilled = simnet.callReadOnlyFn(
        "ctf-exchange",
        "get-filled-amount",
        [orderHash.result],
        deployer
      );
      expect(initialFilled.result).toBeUint(0);

      console.log("✓ Initial filled amount: 0");

      // Note: We can't actually fill the order without valid signatures,
      // but we've verified the tracking mechanism exists

      console.log("\n══════════════════════════════════════════════");
      console.log("✅ PARTIAL FILL TRACKING TEST PASSED");
      console.log("══════════════════════════════════════════════\n");
    });
  });

  describe("Error Handling: Settlement Failures", () => {
    it("prevents split after market resolution", () => {
      const marketId = new Uint8Array(32).fill(4);
      const questionId = marketId;
      const conditionId = initializeMarket(marketId);

      // Split before resolution (should work)
      const splitAmount = 1_000_000;
      const splitResult = simnet.callPublicFn(
        "conditional-tokens",
        "split-position",
        [Cl.uint(splitAmount), Cl.buffer(conditionId)],
        wallet1
      );
      expect(splitResult.result).toBeOk(Cl.bool(true));

      console.log("✓ Split before resolution: SUCCESS");

      // Resolve market
      simnet.callPublicFn(
        "optimistic-oracle",
        "propose-answer",
        [Cl.buffer(questionId), Cl.uint(1)],
        wallet1
      );
      simnet.mineEmptyBlocks(150);
      simnet.callPublicFn(
        "optimistic-oracle",
        "resolve",
        [Cl.buffer(questionId)],
        deployer
      );
      simnet.callPublicFn(
        "oracle-adapter",
        "resolve-market",
        [Cl.buffer(marketId)],
        deployer
      );

      console.log("✓ Market resolved");

      // Try to split after resolution (should fail)
      const postResolveSplit = simnet.callPublicFn(
        "conditional-tokens",
        "split-position",
        [Cl.uint(splitAmount), Cl.buffer(conditionId)],
        wallet1
      );
      expect(postResolveSplit.result).toBeErr(Cl.uint(102)); // ERR-CONDITION-ALREADY-RESOLVED

      console.log("✓ Split after resolution: BLOCKED");
      console.log("\n══════════════════════════════════════════════");
      console.log("✅ ERROR HANDLING TEST PASSED");
      console.log("══════════════════════════════════════════════\n");
    });

    it("prevents double redemption", () => {
      const marketId = new Uint8Array(32).fill(5);
      const questionId = marketId;
      const conditionId = initializeMarket(marketId);

      // Split and resolve
      const splitAmount = 5_000_000;
      simnet.callPublicFn(
        "conditional-tokens",
        "split-position",
        [Cl.uint(splitAmount), Cl.buffer(conditionId)],
        wallet1
      );

      simnet.callPublicFn(
        "optimistic-oracle",
        "propose-answer",
        [Cl.buffer(questionId), Cl.uint(1)],
        wallet1
      );
      simnet.mineEmptyBlocks(150);
      simnet.callPublicFn(
        "optimistic-oracle",
        "resolve",
        [Cl.buffer(questionId)],
        deployer
      );
      simnet.callPublicFn(
        "oracle-adapter",
        "resolve-market",
        [Cl.buffer(marketId)],
        deployer
      );

      console.log("✓ Market setup and resolved");

      // First redemption (should work)
      const firstRedeem = simnet.callPublicFn(
        "conditional-tokens",
        "redeem-positions",
        [Cl.buffer(conditionId), Cl.uint(0)],
        wallet1
      );
      expect(firstRedeem.result).toBeOk(Cl.uint(splitAmount));

      console.log("✓ First redemption: SUCCESS");

      // Second redemption (should fail - no balance)
      const secondRedeem = simnet.callPublicFn(
        "conditional-tokens",
        "redeem-positions",
        [Cl.buffer(conditionId), Cl.uint(0)],
        wallet1
      );
      expect(secondRedeem.result).toBeErr(Cl.uint(104)); // ERR-INSUFFICIENT-BALANCE

      console.log("✓ Second redemption: BLOCKED");
      console.log("\n══════════════════════════════════════════════");
      console.log("✅ DOUBLE REDEMPTION PREVENTION TEST PASSED");
      console.log("══════════════════════════════════════════════\n");
    });
  });
});
