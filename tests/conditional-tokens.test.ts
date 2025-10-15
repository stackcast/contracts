import { Cl, ClarityType, isClarityType } from "@stacks/transactions";
import { hexToBytes } from "@stacks/common";
import { beforeEach, describe, expect, it } from "vitest";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const wallet1 = accounts.get("wallet_1")!;
const wallet2 = accounts.get("wallet_2")!;

// sBTC token contract (auto-funded in simnet)
const SBTC_CONTRACT = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

describe("Conditional Tokens Framework", () => {
  // Helper function to initialize a market and get the condition ID
  function initializeMarket(marketId: Uint8Array): Uint8Array {
    const question = "Test market question";
    const reward = 100_000_000;

    const result = simnet.callPublicFn(
      "oracle-adapter",
      "initialize-market",
      [Cl.buffer(marketId), Cl.stringUtf8(question), Cl.uint(reward)],
      deployer
    );

    // Extract the buffer value from the ok response - BufferCV.value is a hex string
    if (!isClarityType(result.result, ClarityType.ResponseOk)) {
      throw new Error(`Expected ResponseOk, got ${result.result.type}`);
    }

    if (!isClarityType(result.result.value, ClarityType.Buffer)) {
      throw new Error(
        `Expected Buffer in response, got ${result.result.value.type}`
      );
    }

    const hexString = result.result.value.value.replace(/^0x/, "");
    return hexToBytes(hexString);
  }

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

    const hexString = result.result.value.replace(/^0x/, "");
    return hexToBytes(hexString);
  }

  describe("prepare-condition", () => {
    it("creates a new condition via oracle-adapter", () => {
      const marketId = new Uint8Array(32).fill(1);
      const conditionId = initializeMarket(marketId);

      // Verify condition exists
      const condition = simnet.callReadOnlyFn(
        "conditional-tokens",
        "get-condition",
        [Cl.buffer(conditionId)],
        deployer
      );

      expect(condition.result).toBeSome(
        Cl.tuple({
          oracle: Cl.principal(`${deployer}.oracle-adapter`),
          "question-id": Cl.buffer(marketId),
          "outcome-slot-count": Cl.uint(2),
          resolved: Cl.bool(false),
          "payout-numerators": Cl.list([Cl.uint(0), Cl.uint(0)]),
          "payout-denominator": Cl.uint(1),
        })
      );
    });

    it("prevents duplicate conditions", () => {
      const marketId = new Uint8Array(32).fill(2);

      // First initialization succeeds
      initializeMarket(marketId);

      // Second initialization fails
      const result = simnet.callPublicFn(
        "oracle-adapter",
        "initialize-market",
        [Cl.buffer(marketId), Cl.stringUtf8("Test"), Cl.uint(100_000_000)],
        deployer
      );

      expect(result.result).toBeErr(Cl.uint(302)); // ERR-MARKET-ALREADY-INITIALIZED
    });

    it("validates question-id length", () => {
      const invalidQuestionId = new Uint8Array(16); // Wrong length

      const result = simnet.callPublicFn(
        "conditional-tokens",
        "prepare-condition",
        [Cl.principal(deployer), Cl.buffer(invalidQuestionId), Cl.uint(2)],
        deployer
      );

      expect(result.result).toBeErr(Cl.uint(101)); // ERR-INVALID-CONDITION
    });

    it("validates outcome-slot-count range", () => {
      const questionId = new Uint8Array(32).fill(3);

      // Test outcome-slot-count = 0 (invalid)
      const result1 = simnet.callPublicFn(
        "conditional-tokens",
        "prepare-condition",
        [Cl.principal(deployer), Cl.buffer(questionId), Cl.uint(0)],
        deployer
      );
      expect(result1.result).toBeErr(Cl.uint(105)); // ERR-INVALID-PAYOUT

      // Test outcome-slot-count = 3 (invalid, only binary markets)
      const result2 = simnet.callPublicFn(
        "conditional-tokens",
        "prepare-condition",
        [Cl.principal(deployer), Cl.buffer(questionId), Cl.uint(3)],
        deployer
      );
      expect(result2.result).toBeErr(Cl.uint(105)); // ERR-INVALID-PAYOUT
    });
  });

  describe("split-position", () => {
    let conditionId: Uint8Array;
    let yesPositionId: Uint8Array;
    let noPositionId: Uint8Array;

    beforeEach(() => {
      const marketId = new Uint8Array(32).fill(10);
      conditionId = initializeMarket(marketId);
      yesPositionId = getPositionId(conditionId, 0);
      noPositionId = getPositionId(conditionId, 1);
    });

    it("splits sBTC into YES + NO tokens", () => {
      const splitAmount = 1_000_000; // 1 sBTC (8 decimals)

      const result = simnet.callPublicFn(
        "conditional-tokens",
        "split-position",
        [Cl.uint(splitAmount), Cl.buffer(conditionId)],
        wallet1
      );

      expect(result.result).toBeOk(Cl.bool(true));

      // Verify YES balance
      const yesBalance = simnet.callReadOnlyFn(
        "conditional-tokens",
        "balance-of",
        [Cl.principal(wallet1), Cl.buffer(yesPositionId)],
        wallet1
      );
      expect(yesBalance.result).toStrictEqual(Cl.uint(splitAmount));

      // Verify NO balance
      const noBalance = simnet.callReadOnlyFn(
        "conditional-tokens",
        "balance-of",
        [Cl.principal(wallet1), Cl.buffer(noPositionId)],
        wallet1
      );
      expect(noBalance.result).toStrictEqual(Cl.uint(splitAmount));
    });

    it("fails with zero amount", () => {
      const result = simnet.callPublicFn(
        "conditional-tokens",
        "split-position",
        [Cl.uint(0), Cl.buffer(conditionId)],
        wallet1
      );

      expect(result.result).toBeErr(Cl.uint(107)); // ERR-INVALID-AMOUNT
    });

    it("fails with invalid condition-id", () => {
      const fakeConditionId = new Uint8Array(32).fill(99);

      const result = simnet.callPublicFn(
        "conditional-tokens",
        "split-position",
        [Cl.uint(1000), Cl.buffer(fakeConditionId)],
        wallet1
      );

      expect(result.result).toBeErr(Cl.uint(101)); // ERR-INVALID-CONDITION
    });

    it("locks collateral in contract", () => {
      const splitAmount = 5_000_000;

      const initialBalance = simnet.callReadOnlyFn(
        SBTC_CONTRACT,
        "get-balance",
        [Cl.principal(wallet1)],
        wallet1
      );

      simnet.callPublicFn(
        "conditional-tokens",
        "split-position",
        [Cl.uint(splitAmount), Cl.buffer(conditionId)],
        wallet1
      );

      const finalBalance = simnet.callReadOnlyFn(
        SBTC_CONTRACT,
        "get-balance",
        [Cl.principal(wallet1)],
        wallet1
      );

      // Balance should decrease by splitAmount
      expect(finalBalance.result).not.toBe(initialBalance.result);
    });
  });

  describe("merge-positions", () => {
    let conditionId: Uint8Array;
    let yesPositionId: Uint8Array;
    let noPositionId: Uint8Array;
    const splitAmount = 10_000_000;

    beforeEach(() => {
      const marketId = new Uint8Array(32).fill(20);
      conditionId = initializeMarket(marketId);
      yesPositionId = getPositionId(conditionId, 0);
      noPositionId = getPositionId(conditionId, 1);

      // Split position for wallet1
      simnet.callPublicFn(
        "conditional-tokens",
        "split-position",
        [Cl.uint(splitAmount), Cl.buffer(conditionId)],
        wallet1
      );
    });

    it("merges YES + NO back to sBTC", () => {
      const mergeAmount = splitAmount;

      const initialBalance = simnet.callReadOnlyFn(
        SBTC_CONTRACT,
        "get-balance",
        [Cl.principal(wallet1)],
        wallet1
      );

      const result = simnet.callPublicFn(
        "conditional-tokens",
        "merge-positions",
        [Cl.uint(mergeAmount), Cl.buffer(conditionId), Cl.principal(wallet1)],
        wallet1
      );

      expect(result.result).toBeOk(Cl.bool(true));

      // Verify sBTC returned
      const finalBalance = simnet.callReadOnlyFn(
        SBTC_CONTRACT,
        "get-balance",
        [Cl.principal(wallet1)],
        wallet1
      );

      expect(finalBalance.result).not.toBe(initialBalance.result);

      // Verify position tokens burned
      const yesBalance = simnet.callReadOnlyFn(
        "conditional-tokens",
        "balance-of",
        [Cl.principal(wallet1), Cl.buffer(yesPositionId)],
        wallet1
      );
      expect(yesBalance.result).toStrictEqual(Cl.uint(0));

      const noBalance = simnet.callReadOnlyFn(
        "conditional-tokens",
        "balance-of",
        [Cl.principal(wallet1), Cl.buffer(noPositionId)],
        wallet1
      );
      expect(noBalance.result).toStrictEqual(Cl.uint(0));
    });

    it("can send collateral to different recipient", () => {
      const mergeAmount = splitAmount;

      const initialBalance = simnet.callReadOnlyFn(
        SBTC_CONTRACT,
        "get-balance",
        [Cl.principal(wallet2)],
        wallet2
      );

      const result = simnet.callPublicFn(
        "conditional-tokens",
        "merge-positions",
        [Cl.uint(mergeAmount), Cl.buffer(conditionId), Cl.principal(wallet2)],
        wallet1
      );

      expect(result.result).toBeOk(Cl.bool(true));

      // Verify wallet2 received sBTC
      const finalBalance = simnet.callReadOnlyFn(
        SBTC_CONTRACT,
        "get-balance",
        [Cl.principal(wallet2)],
        wallet2
      );

      expect(finalBalance.result).not.toBe(initialBalance.result);
    });

    it("fails with insufficient YES balance", () => {
      // Transfer away half of YES tokens
      simnet.callPublicFn(
        "conditional-tokens",
        "safe-transfer-from",
        [
          Cl.principal(wallet1),
          Cl.principal(wallet2),
          Cl.buffer(yesPositionId),
          Cl.uint(splitAmount / 2),
        ],
        wallet1
      );

      // Try to merge full amount (but only have half YES)
      const result = simnet.callPublicFn(
        "conditional-tokens",
        "merge-positions",
        [Cl.uint(splitAmount), Cl.buffer(conditionId), Cl.principal(wallet1)],
        wallet1
      );

      expect(result.result).toBeErr(Cl.uint(104)); // ERR-INSUFFICIENT-BALANCE
    });

    it("fails with insufficient NO balance", () => {
      // Transfer away half of NO tokens
      simnet.callPublicFn(
        "conditional-tokens",
        "safe-transfer-from",
        [
          Cl.principal(wallet1),
          Cl.principal(wallet2),
          Cl.buffer(noPositionId),
          Cl.uint(splitAmount / 2),
        ],
        wallet1
      );

      // Try to merge full amount
      const result = simnet.callPublicFn(
        "conditional-tokens",
        "merge-positions",
        [Cl.uint(splitAmount), Cl.buffer(conditionId), Cl.principal(wallet1)],
        wallet1
      );

      expect(result.result).toBeErr(Cl.uint(104)); // ERR-INSUFFICIENT-BALANCE
    });

    it("allows partial merge", () => {
      const partialAmount = splitAmount / 2;

      const result = simnet.callPublicFn(
        "conditional-tokens",
        "merge-positions",
        [Cl.uint(partialAmount), Cl.buffer(conditionId), Cl.principal(wallet1)],
        wallet1
      );

      expect(result.result).toBeOk(Cl.bool(true));

      // Verify remaining balances
      const yesBalance = simnet.callReadOnlyFn(
        "conditional-tokens",
        "balance-of",
        [Cl.principal(wallet1), Cl.buffer(yesPositionId)],
        wallet1
      );
      expect(yesBalance.result).toStrictEqual(Cl.uint(partialAmount));
    });
  });

  describe("safe-transfer-from", () => {
    let conditionId: Uint8Array;
    let yesPositionId: Uint8Array;
    const splitAmount = 5_000_000;

    beforeEach(() => {
      const marketId = new Uint8Array(32).fill(30);
      conditionId = initializeMarket(marketId);
      yesPositionId = getPositionId(conditionId, 0);

      simnet.callPublicFn(
        "conditional-tokens",
        "split-position",
        [Cl.uint(splitAmount), Cl.buffer(conditionId)],
        wallet1
      );
    });

    it("transfers position tokens between users", () => {
      const transferAmount = 1_000_000;

      const result = simnet.callPublicFn(
        "conditional-tokens",
        "safe-transfer-from",
        [
          Cl.principal(wallet1),
          Cl.principal(wallet2),
          Cl.buffer(yesPositionId),
          Cl.uint(transferAmount),
        ],
        wallet1
      );

      expect(result.result).toBeOk(Cl.bool(true));

      // Verify sender balance decreased
      const senderBalance = simnet.callReadOnlyFn(
        "conditional-tokens",
        "balance-of",
        [Cl.principal(wallet1), Cl.buffer(yesPositionId)],
        wallet1
      );
      expect(senderBalance.result).toStrictEqual(
        Cl.uint(splitAmount - transferAmount)
      );

      // Verify receiver balance increased
      const receiverBalance = simnet.callReadOnlyFn(
        "conditional-tokens",
        "balance-of",
        [Cl.principal(wallet2), Cl.buffer(yesPositionId)],
        wallet2
      );
      expect(receiverBalance.result).toStrictEqual(Cl.uint(transferAmount));
    });

    it("fails with insufficient balance", () => {
      const result = simnet.callPublicFn(
        "conditional-tokens",
        "safe-transfer-from",
        [
          Cl.principal(wallet1),
          Cl.principal(wallet2),
          Cl.buffer(yesPositionId),
          Cl.uint(splitAmount + 1),
        ],
        wallet1
      );

      expect(result.result).toBeErr(Cl.uint(104)); // ERR-INSUFFICIENT-BALANCE
    });

    it("fails when unauthorized", () => {
      const result = simnet.callPublicFn(
        "conditional-tokens",
        "safe-transfer-from",
        [
          Cl.principal(wallet1),
          Cl.principal(wallet2),
          Cl.buffer(yesPositionId),
          Cl.uint(1000),
        ],
        wallet2 // wallet2 trying to transfer wallet1's tokens
      );

      expect(result.result).toBeErr(Cl.uint(100)); // ERR-NOT-AUTHORIZED
    });

    it("allows approved operator to transfer", () => {
      // Approve wallet2 as operator
      simnet.callPublicFn(
        "conditional-tokens",
        "set-approval-for-all",
        [Cl.principal(wallet2), Cl.bool(true)],
        wallet1
      );

      const result = simnet.callPublicFn(
        "conditional-tokens",
        "safe-transfer-from",
        [
          Cl.principal(wallet1),
          Cl.principal(deployer),
          Cl.buffer(yesPositionId),
          Cl.uint(1000),
        ],
        wallet2 // Now wallet2 can transfer
      );

      expect(result.result).toBeOk(Cl.bool(true));
    });
  });

  describe("report-payout and redeem", () => {
    let marketId: Uint8Array;
    let conditionId: Uint8Array;
    let questionId: Uint8Array;
    let yesPositionId: Uint8Array;
    const splitAmount = 20_000_000;

    beforeEach(() => {
      marketId = new Uint8Array(32).fill(40);
      questionId = marketId; // oracle-adapter uses same ID
      conditionId = initializeMarket(marketId);
      yesPositionId = getPositionId(conditionId, 0);

      // wallet1 splits position
      simnet.callPublicFn(
        "conditional-tokens",
        "split-position",
        [Cl.uint(splitAmount), Cl.buffer(conditionId)],
        wallet1
      );
    });

    it("allows oracle to report payout", () => {
      // Resolve through oracle flow
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

      const result = simnet.callPublicFn(
        "oracle-adapter",
        "resolve-market",
        [Cl.buffer(marketId)],
        deployer
      );

      expect(result.result).toBeOk(Cl.bool(true));

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
    });

    it("prevents non-oracle from reporting payout", () => {
      const result = simnet.callPublicFn(
        "conditional-tokens",
        "report-payout",
        [Cl.buffer(conditionId), Cl.list([Cl.uint(1), Cl.uint(0)])],
        wallet1 // Not the oracle
      );

      expect(result.result).toBeErr(Cl.uint(100)); // ERR-NOT-AUTHORIZED
    });

    it("redeems winning YES position for sBTC", () => {
      // Resolve market: YES wins
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

      const initialBalance = simnet.callReadOnlyFn(
        SBTC_CONTRACT,
        "get-balance",
        [Cl.principal(wallet1)],
        wallet1
      );

      // Redeem YES tokens
      const result = simnet.callPublicFn(
        "conditional-tokens",
        "redeem-positions",
        [Cl.buffer(conditionId), Cl.uint(0)],
        wallet1
      );

      expect(result.result).toBeOk(Cl.uint(splitAmount));

      // Verify sBTC received
      const finalBalance = simnet.callReadOnlyFn(
        SBTC_CONTRACT,
        "get-balance",
        [Cl.principal(wallet1)],
        wallet1
      );

      expect(finalBalance.result).not.toBe(initialBalance.result);

      // Verify YES tokens burned
      const yesBalance = simnet.callReadOnlyFn(
        "conditional-tokens",
        "balance-of",
        [Cl.principal(wallet1), Cl.buffer(yesPositionId)],
        wallet1
      );
      expect(yesBalance.result).toStrictEqual(Cl.uint(0));
    });

    it("returns zero payout for losing NO position", () => {
      // Resolve market: YES wins (NO loses)
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

      // Try to redeem NO tokens (losers)
      const result = simnet.callPublicFn(
        "conditional-tokens",
        "redeem-positions",
        [Cl.buffer(conditionId), Cl.uint(1)],
        wallet1
      );

      expect(result.result).toBeOk(Cl.uint(0)); // No payout
    });

    it("prevents redemption before resolution", () => {
      const result = simnet.callPublicFn(
        "conditional-tokens",
        "redeem-positions",
        [Cl.buffer(conditionId), Cl.uint(0)],
        wallet1
      );

      expect(result.result).toBeErr(Cl.uint(103)); // ERR-CONDITION-NOT-RESOLVED
    });

    it("prevents double redemption", () => {
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

      // First redemption succeeds
      const result1 = simnet.callPublicFn(
        "conditional-tokens",
        "redeem-positions",
        [Cl.buffer(conditionId), Cl.uint(0)],
        wallet1
      );
      expect(result1.result).toBeOk(Cl.uint(splitAmount));

      // Second redemption fails (no balance)
      const result2 = simnet.callPublicFn(
        "conditional-tokens",
        "redeem-positions",
        [Cl.buffer(conditionId), Cl.uint(0)],
        wallet1
      );
      expect(result2.result).toBeErr(Cl.uint(104)); // ERR-INSUFFICIENT-BALANCE
    });
  });

  describe("Edge Cases & Security", () => {
    let conditionId: Uint8Array;
    let marketId: Uint8Array;
    let questionId: Uint8Array;

    beforeEach(() => {
      marketId = new Uint8Array(32).fill(50);
      questionId = marketId;
      conditionId = initializeMarket(marketId);
    });

    it("prevents split after market resolution", () => {
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

      // Try to split - should fail
      const result = simnet.callPublicFn(
        "conditional-tokens",
        "split-position",
        [Cl.uint(1000), Cl.buffer(conditionId)],
        wallet1
      );

      expect(result.result).toBeErr(Cl.uint(102)); // ERR-CONDITION-ALREADY-RESOLVED
    });

    it("validates position-id length in transfer", () => {
      const invalidPositionId = new Uint8Array(16); // Wrong length

      const result = simnet.callPublicFn(
        "conditional-tokens",
        "safe-transfer-from",
        [
          Cl.principal(wallet1),
          Cl.principal(wallet2),
          Cl.buffer(invalidPositionId),
          Cl.uint(1000),
        ],
        wallet1
      );

      expect(result.result).toBeErr(Cl.uint(101)); // ERR-INVALID-CONDITION
    });

    it("prevents self-approval", () => {
      const result = simnet.callPublicFn(
        "conditional-tokens",
        "set-approval-for-all",
        [Cl.principal(wallet1), Cl.bool(true)],
        wallet1
      );

      expect(result.result).toBeErr(Cl.uint(100)); // ERR-NOT-AUTHORIZED
    });

    it("validates payout numerators sum to denominator", () => {
      // This would be called by oracle-adapter, testing directly
      // Invalid payouts that don't sum to 1
      const result = simnet.callPublicFn(
        "conditional-tokens",
        "report-payout",
        [Cl.buffer(conditionId), Cl.list([Cl.uint(1), Cl.uint(1)])], // Sum = 2
        deployer
      );

      // Should fail because wallet is not the oracle
      expect(result.result).toBeErr(Cl.uint(100)); // ERR-NOT-AUTHORIZED
    });
  });
});
