;; UMA CTF Adapter
;; Connects the Optimistic Oracle to the Conditional Tokens Framework
;; Handles market initialization and resolution

;; Error codes
(define-constant ERR-NOT-AUTHORIZED (err u300))
(define-constant ERR-INVALID-MARKET (err u301))
(define-constant ERR-MARKET-ALREADY-INITIALIZED (err u302))
(define-constant ERR-ORACLE-NOT-RESOLVED (err u303))
(define-constant ERR-ALREADY-RESOLVED (err u304))
(define-constant ERR-CONTRACT-CALL-FAILED (err u305))

;; Contract references (these would be replaced with actual deployed addresses)
(define-constant CONDITIONAL_TOKENS_CONTRACT .conditional-tokens)
(define-constant ORACLE_CONTRACT .optimistic-oracle)

;; Data structures

(define-map markets
  { market-id: (buff 32) }
  {
    condition-id: (buff 32),
    question-id: (buff 32),
    question: (string-utf8 256),
    creator: principal,
    reward: uint,
    created-at: uint,
    resolved: bool
  }
)

;; Track market count for easy enumeration
(define-data-var market-count uint u0)
(define-data-var contract-owner principal tx-sender)

;; Initialize a new prediction market
;; This creates both a condition in CTF and a question in the oracle
(define-public (initialize-market
  (market-id (buff 32))
  (question (string-utf8 256))
  (reward uint)
)
  (let
    (
      (question-id market-id) ;; Use same ID for simplicity
      (outcome-slot-count u2) ;; Binary markets (YES/NO)
    )
    (asserts! (is-none (map-get? markets { market-id: market-id })) ERR-MARKET-ALREADY-INITIALIZED)

    ;; Create condition in CTF
    ;; The oracle for this condition will be this adapter contract
    (unwrap! (contract-call? CONDITIONAL_TOKENS_CONTRACT prepare-condition
      (as-contract tx-sender) ;; This contract is the oracle
      question-id
      outcome-slot-count
    ) ERR-CONTRACT-CALL-FAILED)

    ;; Generate condition ID (must match CTF's generation logic)
    (let
      (
        (condition-id (sha256 (concat
          (concat (unwrap-panic (to-consensus-buff? (as-contract tx-sender))) question-id)
          (unwrap-panic (to-consensus-buff? outcome-slot-count))
        )))
      )

      ;; Initialize question in oracle
      (unwrap! (contract-call? ORACLE_CONTRACT initialize-question
        question-id
        question
        reward
      ) ERR-CONTRACT-CALL-FAILED)

      ;; Store market metadata
      (map-set markets
        { market-id: market-id }
        {
          condition-id: condition-id,
          question-id: question-id,
          question: question,
          creator: tx-sender,
          reward: reward,
          created-at: stacks-block-height,
          resolved: false
        }
      )

      ;; Increment market count
      (var-set market-count (+ (var-get market-count) u1))

      (print {
        event: "market-initialized",
        market-id: market-id,
        condition-id: condition-id,
        question: question,
        creator: tx-sender
      })
      (ok condition-id)
    )
  )
)

;; Resolve a market by fetching oracle result and reporting to CTF
(define-public (resolve-market (market-id (buff 32)))
  (let
    (
      (market (unwrap! (map-get? markets { market-id: market-id }) ERR-INVALID-MARKET))
      (question-id (get question-id market))
      (condition-id (get condition-id market))
    )
    (asserts! (not (get resolved market)) ERR-ALREADY-RESOLVED)

    ;; Check if oracle has resolved
    (let
      (
        (oracle-answer (unwrap! (contract-call? ORACLE_CONTRACT get-final-answer question-id) ERR-ORACLE-NOT-RESOLVED))
      )

      ;; Convert oracle answer to payout array
      ;; If answer is 1 (YES), payouts are [1, 0]
      ;; If answer is 0 (NO), payouts are [0, 1]
      (let
        (
          (payout-numerators
            (if (is-eq oracle-answer u1)
              (list u1 u0) ;; YES wins
              (list u0 u1) ;; NO wins
            )
          )
        )

        ;; Report payout to CTF (as contract, since we're the oracle)
        (as-contract
          (unwrap! (contract-call? CONDITIONAL_TOKENS_CONTRACT report-payout
            condition-id
            payout-numerators
          ) ERR-CONTRACT-CALL-FAILED)
        )

        ;; Mark market as resolved
        (map-set markets
          { market-id: market-id }
          (merge market { resolved: true })
        )

        (print {
          event: "market-resolved",
          market-id: market-id,
          condition-id: condition-id,
          outcome: oracle-answer,
          payouts: payout-numerators
        })
        (ok true)
      )
    )
  )
)

;; Helper: Get market by ID
(define-read-only (get-market (market-id (buff 32)))
  (map-get? markets { market-id: market-id })
)

;; Helper: Get total market count
(define-read-only (get-market-count)
  (var-get market-count)
)

;; Helper: Check if market is resolved
(define-read-only (is-market-resolved (market-id (buff 32)))
  (match (map-get? markets { market-id: market-id })
    market (get resolved market)
    false
  )
)

;; Helper: Get condition ID for a market
(define-read-only (get-condition-id (market-id (buff 32)))
  (match (map-get? markets { market-id: market-id })
    market (some (get condition-id market))
    none
  )
)

;; Helper: Get question ID for a market
(define-read-only (get-question-id (market-id (buff 32)))
  (match (map-get? markets { market-id: market-id })
    market (some (get question-id market))
    none
  )
)

;; Admin function to update contract owner
(define-public (set-contract-owner (new-owner principal))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR-NOT-AUTHORIZED)
    (ok (var-set contract-owner new-owner))
  )
)

;; Read contract owner
(define-read-only (get-contract-owner)
  (var-get contract-owner)
)
