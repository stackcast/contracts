;; Conditional Tokens Framework (CTF)
;; Core contract for managing outcome tokens in prediction markets
;; Similar to Gnosis ConditionalTokens.sol

;; Error codes
(define-constant ERR-NOT-AUTHORIZED (err u100))
(define-constant ERR-INVALID-CONDITION (err u101))
(define-constant ERR-CONDITION-ALREADY-RESOLVED (err u102))
(define-constant ERR-CONDITION-NOT-RESOLVED (err u103))
(define-constant ERR-INSUFFICIENT-BALANCE (err u104))
(define-constant ERR-INVALID-PAYOUT (err u105))
(define-constant ERR-TRANSFER-FAILED (err u106))
(define-constant ERR-INVALID-AMOUNT (err u107))

;; Trusted exchange contract (same deployer namespace)
(define-constant EXCHANGE_CONTRACT .ctf-exchange)

;; Data structures

;; Condition: represents a prediction market
(define-map conditions
  { condition-id: (buff 32) }
  {
    oracle: principal,
    question-id: (buff 32),
    outcome-slot-count: uint,
    resolved: bool,
    payout-numerators: (list 2 uint), ;; [YES_PAYOUT, NO_PAYOUT]
    payout-denominator: uint
  }
)

;; Position balances: maps (user, position-id) -> balance
;; position-id encodes: collateral + condition-id + outcome-index
(define-map position-balances
  { owner: principal, position-id: (buff 32) }
  { balance: uint }
)

;; Approval for all: allows operator to manage all positions
(define-map approval-for-all
  { owner: principal, operator: principal }
  { approved: bool }
)

;; Collateral token - using real sBTC (Bitcoin-backed token on Stacks)
;; In simnet/devnet: SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token (deployed via requirements)
;; In testnet: ST1F7QA2MDF17S807EPA36TSS8AMEFY4KA9TVGWXT.sbtc-token
;; In mainnet: SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token

;; Helper: generate position ID from condition and outcome index
(define-private (get-position-id (condition-id (buff 32)) (outcome-index uint))
  (sha256 (concat condition-id (unwrap! (to-consensus-buff? outcome-index) 0x0000000000000000000000000000000000000000000000000000000000000000)))
)

;; Helper: get balance
(define-read-only (balance-of (owner principal) (position-id (buff 32)))
  (default-to u0 (get balance (map-get? position-balances { owner: owner, position-id: position-id })))
)

;; Helper: set balance
(define-private (set-balance (owner principal) (position-id (buff 32)) (amount uint))
  (begin
    (map-set position-balances
      { owner: owner, position-id: position-id }
      { balance: amount }
    )
    true
  )
)

;; Prepare a new condition
(define-public (prepare-condition (oracle principal) (question-id (buff 32)) (outcome-slot-count uint))
  (begin
    ;; Validate inputs before using them
    (asserts! (is-eq (len question-id) u32) ERR-INVALID-CONDITION)
    (asserts! (and (> outcome-slot-count u0) (<= outcome-slot-count u2)) ERR-INVALID-PAYOUT)
    ;; Allow any principal as oracle (contracts or standard principals)
    ;; The oracle-adapter will call this with (as-contract tx-sender) as the oracle
    (let
      (
        (oracle-buff (unwrap! (to-consensus-buff? oracle) ERR-INVALID-CONDITION))
        (outcome-buff (unwrap! (to-consensus-buff? outcome-slot-count) ERR-INVALID-PAYOUT))
      )
      (let
        (
          (condition-id (sha256 (concat (concat oracle-buff question-id) outcome-buff)))
        )
        ;; Validate condition-id is correct length (sha256 always produces 32 bytes)
        (asserts! (is-eq (len condition-id) u32) ERR-INVALID-CONDITION)
        (asserts! (is-none (map-get? conditions { condition-id: condition-id })) ERR-INVALID-CONDITION)
        (map-set conditions
          { condition-id: condition-id }
          {
            oracle: oracle,
            question-id: question-id,
            outcome-slot-count: outcome-slot-count,
            resolved: false,
            payout-numerators: (list u0 u0),
            payout-denominator: u1
          }
        )
        (ok condition-id)
      )
    )
  )
)

;; Split collateral into outcome tokens (e.g., 100 USDA -> 100 YES + 100 NO)
(define-public (split-position
  (collateral-amount uint)
  (condition-id (buff 32))
)
  (begin
    ;; Validate condition-id length before using it
    (asserts! (is-eq (len condition-id) u32) ERR-INVALID-CONDITION)
    (let
      (
        (condition (unwrap! (map-get? conditions { condition-id: condition-id }) ERR-INVALID-CONDITION))
        (yes-position-id (get-position-id condition-id u0))
        (no-position-id (get-position-id condition-id u1))
        (current-yes-balance (balance-of tx-sender yes-position-id))
        (current-no-balance (balance-of tx-sender no-position-id))
      )
      (asserts! (> collateral-amount u0) ERR-INVALID-AMOUNT)
      (asserts! (is-eq (get resolved condition) false) ERR-CONDITION-ALREADY-RESOLVED)

      ;; Transfer sBTC from user to contract (locks collateral)
      (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer
        collateral-amount
        tx-sender
        (as-contract tx-sender)
        none
      ))

      ;; Mint outcome tokens (YES + NO)
      (set-balance tx-sender yes-position-id (+ current-yes-balance collateral-amount))
      (set-balance tx-sender no-position-id (+ current-no-balance collateral-amount))

      (print {
        event: "position-split",
        user: tx-sender,
        condition-id: condition-id,
        amount: collateral-amount
      })
      (ok true)
    )
  )
)

;; Merge outcome tokens back into collateral (e.g., 100 YES + 100 NO -> 100 sBTC)
;; Returns collateral to specified recipient
(define-public (merge-positions
  (collateral-amount uint)
  (condition-id (buff 32))
  (recipient principal)
)
  (begin
    ;; Validate condition-id length before using it
    (asserts! (is-eq (len condition-id) u32) ERR-INVALID-CONDITION)
    (let
      (
        (condition (unwrap! (map-get? conditions { condition-id: condition-id }) ERR-INVALID-CONDITION))
        (yes-position-id (get-position-id condition-id u0))
        (no-position-id (get-position-id condition-id u1))
        (current-yes-balance (balance-of tx-sender yes-position-id))
        (current-no-balance (balance-of tx-sender no-position-id))
      )
      (asserts! (> collateral-amount u0) ERR-INVALID-AMOUNT)
      (asserts! (>= current-yes-balance collateral-amount) ERR-INSUFFICIENT-BALANCE)
      (asserts! (>= current-no-balance collateral-amount) ERR-INSUFFICIENT-BALANCE)

      ;; Burn outcome tokens
      (set-balance tx-sender yes-position-id (- current-yes-balance collateral-amount))
      (set-balance tx-sender no-position-id (- current-no-balance collateral-amount))

      ;; Return sBTC collateral to recipient
      (try! (as-contract (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer
        collateral-amount
        tx-sender
        recipient
        none
      )))

      (print {
        event: "positions-merged",
        user: tx-sender,
        condition-id: condition-id,
        amount: collateral-amount
      })
      (ok true)
    )
  )
)

;; Transfer position tokens
(define-public (safe-transfer-from
  (from principal)
  (to principal)
  (position-id (buff 32))
  (amount uint)
)
  (begin
    ;; Validate inputs before using them
    (asserts! (is-eq (len position-id) u32) ERR-INVALID-CONDITION)
    (asserts! (> amount u0) ERR-INVALID-AMOUNT)
    (asserts! (is-standard to) ERR-NOT-AUTHORIZED)
    (let
      (
        (sender-balance (balance-of from position-id))
        (receiver-balance (balance-of to position-id))
        (is-approved (default-to false (get approved (map-get? approval-for-all { owner: from, operator: tx-sender }))))
        (sender-is-exchange (is-eq tx-sender EXCHANGE_CONTRACT))
      )
      (asserts! (or (is-eq tx-sender from) is-approved sender-is-exchange) ERR-NOT-AUTHORIZED)
      (asserts! (>= sender-balance amount) ERR-INSUFFICIENT-BALANCE)

      ;; Update balances
      (set-balance from position-id (- sender-balance amount))
      (set-balance to position-id (+ receiver-balance amount))

      (print {
        event: "transfer",
        from: from,
        to: to,
        position-id: position-id,
        amount: amount
      })
      (ok true)
    )
  )
)

;; Batch transfer (used by exchange)
(define-public (safe-batch-transfer-from
  (from principal)
  (to principal)
  (position-ids (list 10 (buff 32)))
  (amounts (list 10 uint))
)
  (begin
    (asserts! (is-eq (len position-ids) (len amounts)) ERR-INVALID-AMOUNT)
    (match
      (fold safe-batch-transfer-fold
        (map create-transfer-params position-ids amounts)
        (ok { from: from, to: to })
      )
      final-state (ok true)
      transfer-error (err transfer-error)
    )
  )
)

;; Helper to create transfer params from parallel lists
(define-private (create-transfer-params (position-id (buff 32)) (amount uint))
  { position-id: position-id, amount: amount }
)

;; Fold helper for batch transfers - returns response to propagate errors
(define-private (safe-batch-transfer-fold
  (params { position-id: (buff 32), amount: uint })
  (state (response { from: principal, to: principal } uint))
)
  (match state
    success-state
      (match (safe-transfer-from
               (get from success-state)
               (get to success-state)
               (get position-id params)
               (get amount params))
        transfer-success (ok success-state)
        transfer-failure (err transfer-failure)
      )
    existing-error (err existing-error)
  )
)

;; Set approval for operator
(define-public (set-approval-for-all (operator principal) (approved bool))
  (begin
    ;; Validate operator is not the same as the sender
    (asserts! (is-eq (is-eq operator tx-sender) false) ERR-NOT-AUTHORIZED)
    (ok (map-set approval-for-all
      { owner: tx-sender, operator: operator }
      { approved: approved }
    ))
  )
)

;; Report payout from oracle (only callable by authorized oracle)
(define-public (report-payout (condition-id (buff 32)) (payout-numerators (list 2 uint)))
  (begin
    ;; Validate inputs before using them
    (asserts! (is-eq (len condition-id) u32) ERR-INVALID-CONDITION)
    (asserts! (is-eq (len payout-numerators) u2) ERR-INVALID-PAYOUT)
    (let
      (
        (condition (unwrap! (map-get? conditions { condition-id: condition-id }) ERR-INVALID-CONDITION))
      )
      (asserts! (is-eq tx-sender (get oracle condition)) ERR-NOT-AUTHORIZED)
      (asserts! (is-eq (get resolved condition) false) ERR-CONDITION-ALREADY-RESOLVED)

      ;; Validate payouts (must sum to denominator)
      (let
        (
          (payout-sum (+ (unwrap-panic (element-at payout-numerators u0))
                        (unwrap-panic (element-at payout-numerators u1))))
        )
        (asserts! (is-eq payout-sum u1) ERR-INVALID-PAYOUT)
      )

      (ok (map-set conditions
        { condition-id: condition-id }
        (merge condition {
          resolved: true,
          payout-numerators: payout-numerators,
          payout-denominator: u1
        })
      ))
    )
  )
)

;; Redeem positions after resolution
(define-public (redeem-positions
  (condition-id (buff 32))
  (outcome-index uint)
)
  (begin
    ;; Validate inputs before using them
    (asserts! (is-eq (len condition-id) u32) ERR-INVALID-CONDITION)
    (asserts! (or (is-eq outcome-index u0) (is-eq outcome-index u1)) ERR-INVALID-PAYOUT)
    (let
      (
        (condition (unwrap! (map-get? conditions { condition-id: condition-id }) ERR-INVALID-CONDITION))
        (position-id (get-position-id condition-id outcome-index))
        (balance (balance-of tx-sender position-id))
        (payout-numerator (unwrap-panic (element-at (get payout-numerators condition) outcome-index)))
        (payout-denominator (get payout-denominator condition))
        (payout-amount (/ (* balance payout-numerator) payout-denominator))
      )
      (asserts! (get resolved condition) ERR-CONDITION-NOT-RESOLVED)
      (asserts! (> balance u0) ERR-INSUFFICIENT-BALANCE)

      ;; Burn position tokens
      (set-balance tx-sender position-id u0)

      ;; Transfer sBTC payout to winner
      (if (> payout-amount u0)
        (let ((user tx-sender))
          (try! (as-contract (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer
            payout-amount
            (as-contract tx-sender) ;; FROM: contract escrow
            user                    ;; TO: actual winner
            none
          )))
        )
        true
      )

      (print {
        event: "positions-redeemed",
        user: tx-sender,
        condition-id: condition-id,
        outcome-index: outcome-index,
        payout: payout-amount
      })
      (ok payout-amount)
    )
  )
)

;; Read-only functions

(define-read-only (get-condition (condition-id (buff 32)))
  (map-get? conditions { condition-id: condition-id })
)

(define-read-only (get-outcome-slot-count (condition-id (buff 32)))
  (match (map-get? conditions { condition-id: condition-id })
    condition (some (get outcome-slot-count condition))
    none
  )
)

(define-read-only (is-approved-for-all (owner principal) (operator principal))
  (default-to false (get approved (map-get? approval-for-all { owner: owner, operator: operator })))
)

(define-read-only (get-collection-id (condition-id (buff 32)))
  (if (is-eq (len condition-id) u32)
    (sha256 condition-id)
    0x0000000000000000000000000000000000000000000000000000000000000000
  )
)

(define-read-only (get-position-id-readonly (condition-id (buff 32)) (outcome-index uint))
  (if (and (is-eq (len condition-id) u32) (or (is-eq outcome-index u0) (is-eq outcome-index u1)))
    (get-position-id condition-id outcome-index)
    0x0000000000000000000000000000000000000000000000000000000000000000
  )
)
