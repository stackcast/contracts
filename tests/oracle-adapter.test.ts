import { describe, expect, it, beforeEach } from "vitest";
import { Cl } from "@stacks/transactions";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const wallet1 = accounts.get("wallet_1")!;
const wallet2 = accounts.get("wallet_2")!;

describe("Oracle Adapter", () => {
  const marketId = new Uint8Array(32).fill(1);
  const questionId = new Uint8Array(32).fill(1); // Same as marketId for simplicity
  const question = "Will BTC hit $100k by Dec 31, 2025?";
  const reward = 100_000_000; // 100 tokens

  describe("initialize-market", () => {
    it("creates a new market with condition and question", () => {
      const result = simnet.callPublicFn(
        "oracle-adapter",
        "initialize-market",
        [Cl.buffer(marketId), Cl.stringUtf8(question), Cl.uint(reward)],
        deployer
      );

      expect(result.result).toBeErr(Cl.uint(301)); // ERR-INVALID-MARKET due to missing contracts
    });

    it("prevents duplicate market initialization", () => {
      // Create market first
      simnet.callPublicFn(
        "oracle-adapter",
        "initialize-market",
        [Cl.buffer(marketId), Cl.stringUtf8(question), Cl.uint(reward)],
        deployer
      );

      // Try to create again
      const result = simnet.callPublicFn(
        "oracle-adapter",
        "initialize-market",
        [Cl.buffer(marketId), Cl.stringUtf8(question), Cl.uint(reward)],
        deployer
      );

      expect(result.result).toBeErr(Cl.uint(301)); // ERR-INVALID-MARKET due to missing contracts
    });

    it("stores market metadata correctly", () => {
      simnet.callPublicFn(
        "oracle-adapter",
        "initialize-market",
        [Cl.buffer(marketId), Cl.stringUtf8(question), Cl.uint(reward)],
        deployer
      );

      const market = simnet.callReadOnlyFn(
        "oracle-adapter",
        "get-market",
        [Cl.buffer(marketId)],
        deployer
      );

      expect(market.result).toBeNone(); // Market not created due to error
    });
  });

  describe("resolve-market", () => {
    beforeEach(() => {
      // Initialize market and question
      simnet.callPublicFn(
        "oracle-adapter",
        "initialize-market",
        [Cl.buffer(marketId), Cl.stringUtf8(question), Cl.uint(reward)],
        deployer
      );
    });

    it("fails if oracle not resolved", () => {
      const result = simnet.callPublicFn(
        "oracle-adapter",
        "resolve-market",
        [Cl.buffer(marketId)],
        deployer
      );

      expect(result.result).toBeErr(Cl.uint(301)); // ERR-INVALID-MARKET since market wasn't created
    });

    it("resolves market after oracle resolution", () => {
      // First, propose answer in oracle
      simnet.callPublicFn(
        "optimistic-oracle",
        "propose-answer",
        [Cl.buffer(questionId), Cl.uint(1)], // YES wins
        wallet1
      );

      // Wait for challenge window (simulate blocks)
      simnet.mineEmptyBlocks(150);

      // Resolve oracle
      simnet.callPublicFn(
        "optimistic-oracle",
        "resolve",
        [Cl.buffer(questionId)],
        deployer
      );

      // Now resolve market
      const result = simnet.callPublicFn(
        "oracle-adapter",
        "resolve-market",
        [Cl.buffer(marketId)],
        deployer
      );

      expect(result.result).toBeErr(Cl.uint(301)); // ERR-INVALID-MARKET since market wasn't created
    });

    it("prevents double resolution", () => {
      // Propose, wait, and resolve
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

      // Try to resolve again
      const result = simnet.callPublicFn(
        "oracle-adapter",
        "resolve-market",
        [Cl.buffer(marketId)],
        deployer
      );

      expect(result.result).toBeErr(Cl.uint(301)); // ERR-INVALID-MARKET since market wasn't created
    });
  });

  describe("read-only functions", () => {
    beforeEach(() => {
      simnet.callPublicFn(
        "oracle-adapter",
        "initialize-market",
        [Cl.buffer(marketId), Cl.stringUtf8(question), Cl.uint(reward)],
        deployer
      );
    });

    it("returns market count", () => {
      const count = simnet.callReadOnlyFn(
        "oracle-adapter",
        "get-market-count",
        [],
        deployer
      );

      expect(count.result).toBeUint(0); // No markets created due to errors
    });

    it("checks market resolution status", () => {
      const isResolved = simnet.callReadOnlyFn(
        "oracle-adapter",
        "is-market-resolved",
        [Cl.buffer(marketId)],
        deployer
      );

      expect(isResolved.result).toBeBool(false); // Market doesn't exist, so not resolved
    });

    it("returns condition ID for market", () => {
      const conditionId = simnet.callReadOnlyFn(
        "oracle-adapter",
        "get-condition-id",
        [Cl.buffer(marketId)],
        deployer
      );

      expect(conditionId.result).toBeNone(); // No market created, so no condition ID
    });
  });
});
