import { describe, expect, it, beforeEach } from "vitest";
import { Cl, ClarityType, isClarityType } from "@stacks/transactions";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const wallet1 = accounts.get("wallet_1")!;
const wallet2 = accounts.get("wallet_2")!;
const wallet3 = accounts.get("wallet_3")!;

describe("Optimistic Oracle", () => {
  const questionId = new Uint8Array(32).fill(1);
  const question = "Will ETH hit $10k by Dec 31, 2025?";
  const reward = 1000_000_000; // 1000 tokens

  describe("initialize-question", () => {
    it("creates a new question", () => {
      const result = simnet.callPublicFn(
        "optimistic-oracle",
        "initialize-question",
        [Cl.buffer(questionId), Cl.stringUtf8(question), Cl.uint(reward)],
        deployer
      );

      expect(result.result).toBeOk(Cl.bool(true));
    });

    it("prevents duplicate questions", () => {
      simnet.callPublicFn(
        "optimistic-oracle",
        "initialize-question",
        [Cl.buffer(questionId), Cl.stringUtf8(question), Cl.uint(reward)],
        deployer
      );

      const result = simnet.callPublicFn(
        "optimistic-oracle",
        "initialize-question",
        [Cl.buffer(questionId), Cl.stringUtf8(question), Cl.uint(reward)],
        deployer
      );

      expect(result.result).toBeErr(Cl.uint(201)); // ERR-INVALID-QUESTION
    });

    it("stores question data correctly", () => {
      simnet.callPublicFn(
        "optimistic-oracle",
        "initialize-question",
        [Cl.buffer(questionId), Cl.stringUtf8(question), Cl.uint(reward)],
        deployer
      );

      const questionData = simnet.callReadOnlyFn(
        "optimistic-oracle",
        "get-question",
        [Cl.buffer(questionId)],
        deployer
      );

      expect(questionData.result).toBeSome(
        Cl.tuple({
          requester: Cl.principal(deployer),
          question: Cl.stringUtf8(question),
          reward: Cl.uint(reward),
          timestamp: Cl.uint(3), // Block height when question was created
          state: Cl.uint(1), // STATE-PROPOSED
        })
      );
    });
  });

  describe("propose-answer", () => {
    beforeEach(() => {
      simnet.callPublicFn(
        "optimistic-oracle",
        "initialize-question",
        [Cl.buffer(questionId), Cl.stringUtf8(question), Cl.uint(reward)],
        deployer
      );
    });

    it("allows anyone to propose an answer", () => {
      const result = simnet.callPublicFn(
        "optimistic-oracle",
        "propose-answer",
        [Cl.buffer(questionId), Cl.uint(1)], // YES
        wallet1
      );

      expect(result.result).toBeOk(Cl.bool(true));
    });

    it("prevents duplicate proposals", () => {
      simnet.callPublicFn(
        "optimistic-oracle",
        "propose-answer",
        [Cl.buffer(questionId), Cl.uint(1)],
        wallet1
      );

      const result = simnet.callPublicFn(
        "optimistic-oracle",
        "propose-answer",
        [Cl.buffer(questionId), Cl.uint(0)],
        wallet2
      );

      expect(result.result).toBeErr(Cl.uint(202)); // ERR-ALREADY-PROPOSED
    });

    it("stores proposal data", () => {
      simnet.callPublicFn(
        "optimistic-oracle",
        "propose-answer",
        [Cl.buffer(questionId), Cl.uint(1)],
        wallet1
      );

      const proposal = simnet.callReadOnlyFn(
        "optimistic-oracle",
        "get-proposal",
        [Cl.buffer(questionId)],
        deployer
      );

      expect(proposal.result).toBeSome(
        Cl.tuple({
          "proposer": Cl.principal(wallet1),
          "proposed-answer": Cl.uint(1),
          "bond": Cl.uint(100000000), // BOND_AMOUNT
          "proposal-time": Cl.uint(3), // Block height when proposal was made
        })
      );
    });
  });

  describe("dispute-proposal", () => {
    beforeEach(() => {
      simnet.callPublicFn(
        "optimistic-oracle",
        "initialize-question",
        [Cl.buffer(questionId), Cl.stringUtf8(question), Cl.uint(reward)],
        deployer
      );
      simnet.callPublicFn(
        "optimistic-oracle",
        "propose-answer",
        [Cl.buffer(questionId), Cl.uint(1)],
        wallet1
      );
    });

    it("allows anyone to dispute within challenge window", () => {
      const result = simnet.callPublicFn(
        "optimistic-oracle",
        "dispute-proposal",
        [Cl.buffer(questionId)],
        wallet2
      );

      expect(result.result).toBeOk(Cl.bool(true));
    });

    it("fails if challenge window closed", () => {
      // Mine blocks beyond challenge window (144 blocks = ~24 hours)
      simnet.mineEmptyBlocks(150);

      const result = simnet.callPublicFn(
        "optimistic-oracle",
        "dispute-proposal",
        [Cl.buffer(questionId)],
        wallet2
      );

      expect(result.result).toBeErr(Cl.uint(204)); // ERR-CHALLENGE-WINDOW-CLOSED
    });

    it("prevents duplicate disputes", () => {
      simnet.callPublicFn(
        "optimistic-oracle",
        "dispute-proposal",
        [Cl.buffer(questionId)],
        wallet2
      );

      const result = simnet.callPublicFn(
        "optimistic-oracle",
        "dispute-proposal",
        [Cl.buffer(questionId)],
        wallet3
      );

      expect(result.result).toBeErr(Cl.uint(206)); // ERR-ALREADY-DISPUTED
    });

    it("initializes voting after dispute", () => {
      simnet.callPublicFn(
        "optimistic-oracle",
        "dispute-proposal",
        [Cl.buffer(questionId)],
        wallet2
      );

      const tally = simnet.callReadOnlyFn(
        "optimistic-oracle",
        "get-vote-tally",
        [Cl.buffer(questionId)],
        deployer
      );

      expect(tally.result).toBeSome(
        Cl.tuple({
          "yes-votes": Cl.uint(0),
          "no-votes": Cl.uint(0),
          "voting-ends": Cl.uint(291), // Current block (3) + VOTING_PERIOD (288)
        })
      );
    });
  });

  describe("vote", () => {
    beforeEach(() => {
      simnet.callPublicFn(
        "optimistic-oracle",
        "initialize-question",
        [Cl.buffer(questionId), Cl.stringUtf8(question), Cl.uint(reward)],
        deployer
      );
      simnet.callPublicFn(
        "optimistic-oracle",
        "propose-answer",
        [Cl.buffer(questionId), Cl.uint(1)],
        wallet1
      );
      simnet.callPublicFn(
        "optimistic-oracle",
        "dispute-proposal",
        [Cl.buffer(questionId)],
        wallet2
      );
    });

    it("allows voting after dispute", () => {
      const result = simnet.callPublicFn(
        "optimistic-oracle",
        "vote",
        [Cl.buffer(questionId), Cl.uint(1), Cl.uint(1000)], // Vote YES with 1000 stake
        wallet3
      );

      expect(result.result).toBeOk(Cl.bool(true));
    });

    it("prevents duplicate voting", () => {
      simnet.callPublicFn(
        "optimistic-oracle",
        "vote",
        [Cl.buffer(questionId), Cl.uint(1), Cl.uint(1000)],
        wallet3
      );

      const result = simnet.callPublicFn(
        "optimistic-oracle",
        "vote",
        [Cl.buffer(questionId), Cl.uint(0), Cl.uint(500)],
        wallet3
      );

      expect(result.result).toBeErr(Cl.uint(210)); // ERR-ALREADY-VOTED
    });

    it("updates vote tally correctly", () => {
      simnet.callPublicFn(
        "optimistic-oracle",
        "vote",
        [Cl.buffer(questionId), Cl.uint(1), Cl.uint(1000)],
        wallet3
      );

      const tally = simnet.callReadOnlyFn(
        "optimistic-oracle",
        "get-vote-tally",
        [Cl.buffer(questionId)],
        deployer
      );

      // Tally should show yes-votes increased
      expect(tally.result).toBeSome(
        Cl.tuple({
          "yes-votes": Cl.uint(1000), // Vote amount
          "no-votes": Cl.uint(0),
          "voting-ends": Cl.uint(291), // Current block (3) + VOTING_PERIOD (288)
        })
      );
    });

    it("fails if voting period expired", () => {
      // Mine blocks beyond voting period (288 blocks = ~48 hours)
      simnet.mineEmptyBlocks(300);

      const result = simnet.callPublicFn(
        "optimistic-oracle",
        "vote",
        [Cl.buffer(questionId), Cl.uint(1), Cl.uint(1000)],
        wallet3
      );

      expect(result.result).toBeErr(Cl.uint(204)); // ERR-CHALLENGE-WINDOW-CLOSED
    });
  });

  describe("resolve", () => {
    beforeEach(() => {
      simnet.callPublicFn(
        "optimistic-oracle",
        "initialize-question",
        [Cl.buffer(questionId), Cl.stringUtf8(question), Cl.uint(reward)],
        deployer
      );
    });

    it("resolves undisputed proposal after challenge window", () => {
      simnet.callPublicFn(
        "optimistic-oracle",
        "propose-answer",
        [Cl.buffer(questionId), Cl.uint(1)],
        wallet1
      );

      // Wait for challenge window
      simnet.mineEmptyBlocks(150);

      const result = simnet.callPublicFn(
        "optimistic-oracle",
        "resolve",
        [Cl.buffer(questionId)],
        deployer
      );

      expect(result.result).toBeOk(Cl.uint(1)); // Returns final answer
    });

    it("fails if challenge window still open", () => {
      simnet.callPublicFn(
        "optimistic-oracle",
        "propose-answer",
        [Cl.buffer(questionId), Cl.uint(1)],
        wallet1
      );

      const result = simnet.callPublicFn(
        "optimistic-oracle",
        "resolve",
        [Cl.buffer(questionId)],
        deployer
      );

      expect(result.result).toBeErr(Cl.uint(205)); // ERR-CHALLENGE-WINDOW-OPEN
    });

    it("resolves disputed proposal after voting", () => {
      simnet.callPublicFn(
        "optimistic-oracle",
        "propose-answer",
        [Cl.buffer(questionId), Cl.uint(1)],
        wallet1
      );
      simnet.callPublicFn(
        "optimistic-oracle",
        "dispute-proposal",
        [Cl.buffer(questionId)],
        wallet2
      );

      // Vote YES
      simnet.callPublicFn(
        "optimistic-oracle",
        "vote",
        [Cl.buffer(questionId), Cl.uint(1), Cl.uint(1000)],
        wallet3
      );

      // Wait for voting period
      simnet.mineEmptyBlocks(300);

      const result = simnet.callPublicFn(
        "optimistic-oracle",
        "resolve",
        [Cl.buffer(questionId)],
        deployer
      );

      expect(result.result).toBeOk(Cl.uint(1)); // YES wins
    });

    it("prevents double resolution", () => {
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
        "optimistic-oracle",
        "resolve",
        [Cl.buffer(questionId)],
        deployer
      );

      expect(result.result).toBeErr(Cl.uint(208)); // ERR-ALREADY-RESOLVED
    });

    it("stores final answer", () => {
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

      const finalAnswer = simnet.callReadOnlyFn(
        "optimistic-oracle",
        "get-final-answer",
        [Cl.buffer(questionId)],
        deployer
      );

      expect(finalAnswer.result).toBeSome(Cl.uint(1));
    });
  });

  describe("bond distribution", () => {
    const BOND_AMOUNT = 100_000_000n; // 100 tokens
    const SBTC_CONTRACT = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

    beforeEach(() => {
      simnet.callPublicFn(
        "optimistic-oracle",
        "initialize-question",
        [Cl.buffer(questionId), Cl.stringUtf8(question), Cl.uint(reward)],
        deployer
      );
    });

    it("returns proposer's bond when no dispute occurs", () => {
      // Record initial balance
      const initialBalance = simnet.callReadOnlyFn(
        SBTC_CONTRACT,
        "get-balance",
        [Cl.principal(wallet1)],
        wallet1
      );

      // Propose answer (locks bond)
      simnet.callPublicFn(
        "optimistic-oracle",
        "propose-answer",
        [Cl.buffer(questionId), Cl.uint(1)],
        wallet1
      );

      // Wait and resolve
      simnet.mineEmptyBlocks(150);
      simnet.callPublicFn(
        "optimistic-oracle",
        "resolve",
        [Cl.buffer(questionId)],
        deployer
      );

      const finalBalance = simnet.callReadOnlyFn(
        SBTC_CONTRACT,
        "get-balance",
        [Cl.principal(wallet1)],
        wallet1
      );

      // Balance should return to initial (bond returned)
      expect(finalBalance.result).toStrictEqual(initialBalance.result);
    });

    it("returns both bonds to disputer when disputer wins", () => {
      const proposerInitial = simnet.callReadOnlyFn(
        SBTC_CONTRACT,
        "get-balance",
        [Cl.principal(wallet1)],
        wallet1
      );

      const disputerInitial = simnet.callReadOnlyFn(
        SBTC_CONTRACT,
        "get-balance",
        [Cl.principal(wallet2)],
        wallet2
      );

      // Propose NO
      simnet.callPublicFn(
        "optimistic-oracle",
        "propose-answer",
        [Cl.buffer(questionId), Cl.uint(0)],
        wallet1
      );

      // Dispute
      simnet.callPublicFn(
        "optimistic-oracle",
        "dispute-proposal",
        [Cl.buffer(questionId)],
        wallet2
      );

      // Vote YES (disputer is correct, proposer wrong)
      simnet.callPublicFn(
        "optimistic-oracle",
        "vote",
        [Cl.buffer(questionId), Cl.uint(1), Cl.uint(1_000_000)],
        wallet3
      );

      // Wait and resolve
      simnet.mineEmptyBlocks(300);
      simnet.callPublicFn(
        "optimistic-oracle",
        "resolve",
        [Cl.buffer(questionId)],
        deployer
      );

      const proposerFinal = simnet.callReadOnlyFn(
        SBTC_CONTRACT,
        "get-balance",
        [Cl.principal(wallet1)],
        wallet1
      );

      const disputerFinal = simnet.callReadOnlyFn(
        SBTC_CONTRACT,
        "get-balance",
        [Cl.principal(wallet2)],
        wallet2
      );

      // Proposer loses their bond
      if (!isClarityType(proposerInitial.result, ClarityType.ResponseOk)) {
        throw new Error("Expected ResponseOk for proposer initial balance");
      }
      if (!isClarityType(proposerInitial.result.value, ClarityType.UInt)) {
        throw new Error("Expected UInt in response for proposer initial balance");
      }

      if (!isClarityType(proposerFinal.result, ClarityType.ResponseOk)) {
        throw new Error("Expected ResponseOk for proposer final balance");
      }
      if (!isClarityType(proposerFinal.result.value, ClarityType.UInt)) {
        throw new Error("Expected UInt in response for proposer final balance");
      }

      expect(proposerFinal.result.value).toStrictEqual(
        Cl.uint(BigInt(proposerInitial.result.value.value) - BOND_AMOUNT)
      );

      // Disputer gets their bond back + proposer's bond
      if (!isClarityType(disputerInitial.result, ClarityType.ResponseOk)) {
        throw new Error("Expected ResponseOk for disputer initial balance");
      }
      if (!isClarityType(disputerInitial.result.value, ClarityType.UInt)) {
        throw new Error("Expected UInt in response for disputer initial balance");
      }

      if (!isClarityType(disputerFinal.result, ClarityType.ResponseOk)) {
        throw new Error("Expected ResponseOk for disputer final balance");
      }
      if (!isClarityType(disputerFinal.result.value, ClarityType.UInt)) {
        throw new Error("Expected UInt in response for disputer final balance");
      }

      expect(disputerFinal.result.value).toStrictEqual(
        Cl.uint(BigInt(disputerInitial.result.value.value) + BOND_AMOUNT)
      );
    });

    it("returns both bonds to proposer when proposer wins", () => {
      const proposerInitial = simnet.callReadOnlyFn(
        SBTC_CONTRACT,
        "get-balance",
        [Cl.principal(wallet1)],
        wallet1
      );

      const disputerInitial = simnet.callReadOnlyFn(
        SBTC_CONTRACT,
        "get-balance",
        [Cl.principal(wallet2)],
        wallet2
      );

      // Propose YES
      simnet.callPublicFn(
        "optimistic-oracle",
        "propose-answer",
        [Cl.buffer(questionId), Cl.uint(1)],
        wallet1
      );

      // Dispute
      simnet.callPublicFn(
        "optimistic-oracle",
        "dispute-proposal",
        [Cl.buffer(questionId)],
        wallet2
      );

      // Vote YES (proposer is correct)
      simnet.callPublicFn(
        "optimistic-oracle",
        "vote",
        [Cl.buffer(questionId), Cl.uint(1), Cl.uint(1_000_000)],
        wallet3
      );

      // Wait and resolve
      simnet.mineEmptyBlocks(300);
      simnet.callPublicFn(
        "optimistic-oracle",
        "resolve",
        [Cl.buffer(questionId)],
        deployer
      );

      const proposerFinal = simnet.callReadOnlyFn(
        SBTC_CONTRACT,
        "get-balance",
        [Cl.principal(wallet1)],
        wallet1
      );

      const disputerFinal = simnet.callReadOnlyFn(
        SBTC_CONTRACT,
        "get-balance",
        [Cl.principal(wallet2)],
        wallet2
      );

      // Proposer gets their bond back + disputer's bond
      if (!isClarityType(proposerInitial.result, ClarityType.ResponseOk)) {
        throw new Error("Expected ResponseOk for proposer initial balance");
      }
      if (!isClarityType(proposerInitial.result.value, ClarityType.UInt)) {
        throw new Error("Expected UInt in response for proposer initial balance");
      }

      if (!isClarityType(proposerFinal.result, ClarityType.ResponseOk)) {
        throw new Error("Expected ResponseOk for proposer final balance");
      }
      if (!isClarityType(proposerFinal.result.value, ClarityType.UInt)) {
        throw new Error("Expected UInt in response for proposer final balance");
      }

      expect(proposerFinal.result.value).toStrictEqual(
        Cl.uint(BigInt(proposerInitial.result.value.value) + BOND_AMOUNT)
      );

      // Disputer loses their bond
      if (!isClarityType(disputerInitial.result, ClarityType.ResponseOk)) {
        throw new Error("Expected ResponseOk for disputer initial balance");
      }
      if (!isClarityType(disputerInitial.result.value, ClarityType.UInt)) {
        throw new Error("Expected UInt in response for disputer initial balance");
      }

      if (!isClarityType(disputerFinal.result, ClarityType.ResponseOk)) {
        throw new Error("Expected ResponseOk for disputer final balance");
      }
      if (!isClarityType(disputerFinal.result.value, ClarityType.UInt)) {
        throw new Error("Expected UInt in response for disputer final balance");
      }

      expect(disputerFinal.result.value).toStrictEqual(
        Cl.uint(BigInt(disputerInitial.result.value.value) - BOND_AMOUNT)
      );
    });
  });

  describe("read-only functions", () => {
    beforeEach(() => {
      simnet.callPublicFn(
        "optimistic-oracle",
        "initialize-question",
        [Cl.buffer(questionId), Cl.stringUtf8(question), Cl.uint(reward)],
        deployer
      );
    });

    it("checks if question is resolved", () => {
      const isResolved = simnet.callReadOnlyFn(
        "optimistic-oracle",
        "is-resolved",
        [Cl.buffer(questionId)],
        deployer
      );

      expect(isResolved.result).toBeBool(false);
    });

    it("returns none for unresolved question", () => {
      const finalAnswer = simnet.callReadOnlyFn(
        "optimistic-oracle",
        "get-final-answer",
        [Cl.buffer(questionId)],
        deployer
      );

      expect(finalAnswer.result).toBeNone();
    });
  });
});
