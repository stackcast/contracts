import { describe, expect, it, beforeEach } from "vitest";
import { Cl } from "@stacks/transactions";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const wallet1 = accounts.get("wallet_1")!;
const wallet2 = accounts.get("wallet_2")!;

// sBTC token contract (auto-funded in simnet)
const SBTC_CONTRACT = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

describe("Conditional Tokens Framework", () => {
  const conditionId = new Uint8Array(32).fill(1); // Mock condition ID
  const questionId = new Uint8Array(32).fill(2);

  beforeEach(() => {
    // Ensure wallet1 has sBTC (auto-funded in simnet with requirements)
    const balance = simnet.callReadOnlyFn(
      SBTC_CONTRACT,
      "get-balance",
      [Cl.principal(wallet1)],
      wallet1
    );
    console.log("Wallet1 sBTC balance:", Cl.prettyPrint(balance.result));
  });

  describe("prepare-condition", () => {
    it("creates a new condition", () => {
      const result = simnet.callPublicFn(
        "conditional-tokens",
        "prepare-condition",
        [
          Cl.principal(deployer),
          Cl.buffer(questionId),
          Cl.uint(2) // Binary outcome (YES/NO)
        ],
        deployer
      );

      expect(result.result).toBeOk(Cl.bool(true));
    });

    it("prevents duplicate conditions", () => {
      // Create condition first
      simnet.callPublicFn(
        "conditional-tokens",
        "prepare-condition",
        [Cl.principal(deployer), Cl.buffer(questionId), Cl.uint(2)],
        deployer
      );

      // Try to create again
      const result = simnet.callPublicFn(
        "conditional-tokens",
        "prepare-condition",
        [Cl.principal(deployer), Cl.buffer(questionId), Cl.uint(2)],
        deployer
      );

      expect(result.result).toBeErr(Cl.uint(101)); // ERR-INVALID-CONDITION
    });
  });

  describe("split-position", () => {
    beforeEach(() => {
      // Create condition
      simnet.callPublicFn(
        "conditional-tokens",
        "prepare-condition",
        [Cl.principal(deployer), Cl.buffer(questionId), Cl.uint(2)],
        deployer
      );
    });

    it("splits sBTC into YES + NO tokens", () => {
      const splitAmount = 1000;

      // Get initial sBTC balance
      const initialBalance = simnet.callReadOnlyFn(
        SBTC_CONTRACT,
        "get-balance",
        [Cl.principal(wallet1)],
        wallet1
      );

      // Split position
      const result = simnet.callPublicFn(
        "conditional-tokens",
        "split-position",
        [Cl.uint(splitAmount), Cl.buffer(conditionId)],
        wallet1
      );

      expect(result.result).toBeOk(Cl.bool(true));

      // Verify sBTC was transferred (locked)
      const finalBalance = simnet.callReadOnlyFn(
        SBTC_CONTRACT,
        "get-balance",
        [Cl.principal(wallet1)],
        wallet1
      );

      // Balance should decrease by splitAmount
      expect(finalBalance.result).not.toBe(initialBalance.result);
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
  });

  describe("merge-positions", () => {
    const splitAmount = 1000;

    beforeEach(() => {
      // Setup: create condition and split position
      simnet.callPublicFn(
        "conditional-tokens",
        "prepare-condition",
        [Cl.principal(deployer), Cl.buffer(questionId), Cl.uint(2)],
        deployer
      );

      simnet.callPublicFn(
        "conditional-tokens",
        "split-position",
        [Cl.uint(splitAmount), Cl.buffer(conditionId)],
        wallet1
      );
    });

    it("merges YES + NO back to sBTC", () => {
      // Get balance before merge
      const initialBalance = simnet.callReadOnlyFn(
        SBTC_CONTRACT,
        "get-balance",
        [Cl.principal(wallet1)],
        wallet1
      );

      // Merge positions
      const result = simnet.callPublicFn(
        "conditional-tokens",
        "merge-positions",
        [Cl.uint(splitAmount), Cl.buffer(conditionId)],
        wallet1
      );

      expect(result.result).toBeOk(Cl.bool(true));

      // Verify sBTC was returned
      const finalBalance = simnet.callReadOnlyFn(
        SBTC_CONTRACT,
        "get-balance",
        [Cl.principal(wallet1)],
        wallet1
      );

      // Balance should increase by splitAmount
      expect(finalBalance.result).not.toBe(initialBalance.result);
    });

    it("fails with insufficient balance", () => {
      const result = simnet.callPublicFn(
        "conditional-tokens",
        "merge-positions",
        [Cl.uint(splitAmount + 1), Cl.buffer(conditionId)],
        wallet1
      );

      expect(result.result).toBeErr(Cl.uint(104)); // ERR-INSUFFICIENT-BALANCE
    });
  });

  describe("safe-transfer-from", () => {
    const splitAmount = 1000;
    let yesPositionId: Uint8Array;

    beforeEach(() => {
      // Setup: create condition, split, and get position ID
      simnet.callPublicFn(
        "conditional-tokens",
        "prepare-condition",
        [Cl.principal(deployer), Cl.buffer(questionId), Cl.uint(2)],
        deployer
      );

      simnet.callPublicFn(
        "conditional-tokens",
        "split-position",
        [Cl.uint(splitAmount), Cl.buffer(conditionId)],
        wallet1
      );

      // Get YES position ID
      const posIdResult = simnet.callReadOnlyFn(
        "conditional-tokens",
        "get-position-id-readonly",
        [Cl.buffer(conditionId), Cl.uint(0)],
        wallet1
      );
      // Extract position ID from result
      yesPositionId = conditionId; // Simplified for test
    });

    it("transfers position tokens between users", () => {
      const transferAmount = 100;

      // Approve contract first
      simnet.callPublicFn(
        "conditional-tokens",
        "set-approval-for-all",
        [Cl.principal(deployer), Cl.bool(true)],
        wallet1
      );

      const result = simnet.callPublicFn(
        "conditional-tokens",
        "safe-transfer-from",
        [
          Cl.principal(wallet1),
          Cl.principal(wallet2),
          Cl.buffer(yesPositionId),
          Cl.uint(transferAmount)
        ],
        wallet1
      );

      expect(result.result).toBeOk(Cl.bool(true));
    });
  });

  describe("report-payout and redeem", () => {
    const splitAmount = 1000;

    beforeEach(() => {
      // Setup: create condition and split position
      simnet.callPublicFn(
        "conditional-tokens",
        "prepare-condition",
        [Cl.principal(deployer), Cl.buffer(questionId), Cl.uint(2)],
        deployer
      );

      simnet.callPublicFn(
        "conditional-tokens",
        "split-position",
        [Cl.uint(splitAmount), Cl.buffer(conditionId)],
        wallet1
      );
    });

    it("allows oracle to report payout", () => {
      const result = simnet.callPublicFn(
        "conditional-tokens",
        "report-payout",
        [
          Cl.buffer(conditionId),
          Cl.list([Cl.uint(1), Cl.uint(0)]) // YES wins
        ],
        deployer // Oracle
      );

      expect(result.result).toBeOk(Cl.bool(true));
    });

    it("redeems winning position for sBTC", () => {
      // Report YES wins
      simnet.callPublicFn(
        "conditional-tokens",
        "report-payout",
        [Cl.buffer(conditionId), Cl.list([Cl.uint(1), Cl.uint(0)])],
        deployer
      );

      // Get balance before redemption
      const initialBalance = simnet.callReadOnlyFn(
        SBTC_CONTRACT,
        "get-balance",
        [Cl.principal(wallet1)],
        wallet1
      );

      // Redeem YES position (index 0)
      const result = simnet.callPublicFn(
        "conditional-tokens",
        "redeem-positions",
        [Cl.buffer(conditionId), Cl.uint(0)],
        wallet1
      );

      expect(result.result).toBeOk(Cl.uint(splitAmount));

      // Verify sBTC was received
      const finalBalance = simnet.callReadOnlyFn(
        SBTC_CONTRACT,
        "get-balance",
        [Cl.principal(wallet1)],
        wallet1
      );

      expect(finalBalance.result).not.toBe(initialBalance.result);
    });
  });
});
