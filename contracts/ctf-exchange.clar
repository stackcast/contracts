;; CTF Exchange
;; Settlement layer for prediction market trades
;; Matches off-chain orders and executes on-chain atomic swaps
;;
;; Supports three execution modes:
;; 1. NORMAL: BUY + SELL same outcome (token swap)
;; 2. MINT: BUY + BUY opposite outcomes (split collateral into YES+NO)
;; 3. MERGE: SELL + SELL opposite outcomes (merge YES+NO back to collateral)

;; Error codes
(define-constant ERR-NOT-AUTHORIZED (err u400))
(define-constant ERR-INVALID-ORDER (err u401))
(define-constant ERR-ORDER-EXPIRED (err u402))
(define-constant ERR-ORDER-CANCELLED (err u403))
(define-constant ERR-INSUFFICIENT-BALANCE (err u404))
(define-constant ERR-INVALID-SIGNATURE (err u405))
(define-constant ERR-ORDER-FILLED (err u406))
(define-constant ERR-INVALID-AMOUNTS (err u407))
(define-constant ERR-PAUSED (err u408))
(define-constant ERR-SBTC-TRANSFER-FAILED (err u409))
(define-constant ERR-INSUFFICIENT-COLLATERAL (err u410))

;; Constants
(define-constant CONTRACT_OWNER tx-sender)
(define-constant FEE_BPS u50) ;; 0.5% fee (50 basis points)
(define-constant FEE_DENOMINATOR u10000)

;; Contract references
(define-constant CTF_CONTRACT .conditional-tokens)
(define-constant SBTC_TOKEN 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)

;; Data structures

;; Order struct (stored off-chain, verified on-chain)
;; Order hash = sha256(maker + taker + position-id + maker-amount + taker-amount + salt + expiration)

(define-map filled-orders
  { order-hash: (buff 32) }
  { filled-amount: uint }
)

(define-map cancelled-orders
  { order-hash: (buff 32) }
  { cancelled: bool }
)

;; Collateral balances (escrowed sBTC ready for mint settlements)
(define-map collateral-balances
  { owner: principal }
  { balance: uint }
)

;; Fee receiver
(define-data-var fee-receiver principal CONTRACT_OWNER)

;; Paused state for emergency
(define-data-var is-paused bool false)

;; Helper: Compute order hash
(define-read-only (hash-order
  (maker principal)
  (maker-position-id (buff 32))
  (taker-position-id (buff 32))
  (maker-amount uint)
  (taker-amount uint)
  (salt uint)
  (expiration uint)
)
  ;; Order hash is bound only to the maker's commitment.
  ;; The taker is determined at settlement time, so we do not include it.
  (sha256 (concat
    (concat
      (concat
        (concat
          (concat
            (concat
              (unwrap-panic (to-consensus-buff? maker))
              maker-position-id
            )
            taker-position-id
          )
          (unwrap-panic (to-consensus-buff? maker-amount))
        )
        (unwrap-panic (to-consensus-buff? taker-amount))
      )
      (unwrap-panic (to-consensus-buff? salt))
    )
    (unwrap-panic (to-consensus-buff? expiration))
  ))
)

;; Helper: Calculate fee
(define-private (calculate-fee (amount uint))
  (/ (* amount FEE_BPS) FEE_DENOMINATOR)
)

;; Collateral helpers --------------------------------------------------------

(define-private (get-collateral (owner principal))
  (default-to u0 (get balance (map-get? collateral-balances { owner: owner })))
)

(define-private (set-collateral (owner principal) (amount uint))
  (if (> amount u0)
    (map-set collateral-balances { owner: owner } { balance: amount })
    (map-delete collateral-balances { owner: owner })
  )
)

(define-private (credit-collateral (owner principal) (amount uint))
  (set-collateral owner (+ (get-collateral owner) amount))
)

(define-private (deduct-collateral (owner principal) (amount uint))
  (let ((current (get-collateral owner)))
    (asserts! (>= current amount) ERR-INSUFFICIENT-COLLATERAL)
    (set-collateral owner (- current amount))
    (ok true)
  )
)

(define-public (deposit-collateral (amount uint))
  (begin
    (asserts! (> amount u0) ERR-INVALID-AMOUNTS)
    (unwrap! (contract-call? SBTC_TOKEN transfer
      amount
      tx-sender
      (as-contract tx-sender)
      none
    ) ERR-SBTC-TRANSFER-FAILED)
    (credit-collateral tx-sender amount)
    (print {
      event: "collateral-deposit",
      user: tx-sender,
      amount: amount,
      new-balance: (get-collateral tx-sender)
    })
    (ok true)
  )
)

(define-public (withdraw-collateral (amount uint))
  (let ((caller tx-sender))
    (begin
      (asserts! (> amount u0) ERR-INVALID-AMOUNTS)
      (unwrap! (deduct-collateral caller amount) ERR-INSUFFICIENT-COLLATERAL)
      (unwrap! (as-contract (contract-call? SBTC_TOKEN transfer
        amount
        tx-sender
        caller
        none
      )) ERR-SBTC-TRANSFER-FAILED)
      (print {
        event: "collateral-withdraw",
        user: caller,
        amount: amount,
        remaining: (get-collateral caller)
      })
      (ok true)
    )
  )
)

(define-read-only (get-collateral-balance (owner principal))
  (ok (get-collateral owner))
)

;; Helper: Verify order signature using ECDSA secp256k1
;; Recovers public key from signature and verifies it matches expected signer
(define-private (verify-signature
  (order-hash (buff 32))
  (signature (buff 65))
  (expected-signer principal)
)
  (match (secp256k1-recover? order-hash signature)
    recovered-pubkey
      ;; Derive principal from recovered public key
      (match (principal-of? recovered-pubkey)
        derived-principal
          ;; Check if derived principal matches expected signer
          (is-eq derived-principal expected-signer)
        ;; If principal derivation fails, signature is invalid
        err-value false
      )
    ;; If public key recovery fails, signature is invalid
    err-value false
  )
)

;; Match and settle orders
;; This is called by the CLOB operator after matching orders off-chain
;; Requires ECDSA signatures from both maker and taker for production security
(define-public (fill-order
  ;; Maker order
  (maker principal)
  (maker-position-id (buff 32))
  (maker-amount uint)
  (maker-signature (buff 65))
  ;; Taker order
  (taker principal)
  (taker-position-id (buff 32))
  (taker-amount uint)
  ;; Order metadata
  (salt uint)
  (expiration uint)
  ;; Fill amount
  (fill-amount uint)
)
  (begin
    ;; Validate inputs before using them
    (asserts! (is-standard maker) ERR-NOT-AUTHORIZED)
    (asserts! (is-standard taker) ERR-NOT-AUTHORIZED)
    (asserts! (is-eq (len maker-position-id) u32) ERR-INVALID-ORDER)
    (asserts! (is-eq (len taker-position-id) u32) ERR-INVALID-ORDER)
    (asserts! (is-eq (len maker-signature) u65) ERR-INVALID-SIGNATURE)
    (asserts! (> maker-amount u0) ERR-INVALID-AMOUNTS)
    (asserts! (> taker-amount u0) ERR-INVALID-AMOUNTS)
    (asserts! (> fill-amount u0) ERR-INVALID-AMOUNTS)
    (asserts! (<= fill-amount maker-amount) ERR-INVALID-AMOUNTS)
    (asserts! (> expiration burn-block-height) ERR-ORDER-EXPIRED)
    
    (let
      (
        (order-hash (hash-order maker maker-position-id taker-position-id maker-amount taker-amount salt expiration))
        (filled-amount (default-to u0 (get filled-amount (map-get? filled-orders { order-hash: order-hash }))))
      )
      ;; Checks
      (asserts! (not (var-get is-paused)) ERR-PAUSED)
      (asserts! (< burn-block-height expiration) ERR-ORDER-EXPIRED)
      (asserts! (is-none (map-get? cancelled-orders { order-hash: order-hash })) ERR-ORDER-CANCELLED)
      (asserts! (< filled-amount maker-amount) ERR-ORDER-FILLED)
      (asserts! (<= (+ filled-amount fill-amount) maker-amount) ERR-INVALID-AMOUNTS)

      ;; Verify signatures - PRODUCTION SECURITY
      ;; Maker must sign the order hash to authorize the trade
      (asserts! (verify-signature order-hash maker-signature maker) ERR-INVALID-SIGNATURE)

      ;; Check balances before attempting transfers (fail fast)
      (let
        (
          (maker-balance (contract-call? CTF_CONTRACT balance-of maker maker-position-id))
          (proportional-taker-amount (/ (* taker-amount fill-amount) maker-amount))
          (taker-balance (contract-call? CTF_CONTRACT balance-of taker taker-position-id))
          (fee (calculate-fee proportional-taker-amount))
        )
        ;; Verify sufficient balances
        (asserts! (>= maker-balance fill-amount) ERR-INSUFFICIENT-BALANCE)
        (asserts! (>= taker-balance (+ proportional-taker-amount fee)) ERR-INSUFFICIENT-BALANCE)

        ;; Execute the swap
        ;; 1. Transfer maker's position tokens to taker
        (unwrap! (as-contract (contract-call? CTF_CONTRACT safe-transfer-from
          maker
          taker
          maker-position-id
          fill-amount
        )) ERR-INSUFFICIENT-BALANCE)

        ;; 2. Transfer taker's position tokens to maker (minus fee)
        (let
          (
            (taker-amount-after-fee (- proportional-taker-amount fee))
          )
          (unwrap! (as-contract (contract-call? CTF_CONTRACT safe-transfer-from
            taker
            maker
            taker-position-id
            taker-amount-after-fee
          )) ERR-INSUFFICIENT-BALANCE)

          ;; 3. Transfer fee to fee receiver
          (if (> fee u0)
            (unwrap! (as-contract (contract-call? CTF_CONTRACT safe-transfer-from
              taker
              (var-get fee-receiver)
              taker-position-id
              fee
            )) ERR-INSUFFICIENT-BALANCE)
            true
          )
        )

        ;; Update filled amount
        (map-set filled-orders
          { order-hash: order-hash }
          { filled-amount: (+ filled-amount fill-amount) }
        )

        (print {
          event: "order-filled",
          order-hash: order-hash,
          maker: maker,
          taker: taker,
          maker-position-id: maker-position-id,
          taker-position-id: taker-position-id,
          fill-amount: fill-amount,
          fee: fee
        })
        (ok true)
      )
    )
  )
)

;; Fill order via MINT mode (both buyers)
;; Buyers pre-deposit sBTC collateral which is used to mint YES/NO tokens on-demand.
(define-public (fill-order-mint
  ;; Buyer 1 (resting order)
  (buyer-1 principal)
  (buyer-1-maker-position-id (buff 32))
  (buyer-1-taker-position-id (buff 32))
  (buyer-1-amount uint)
  (buyer-1-payment uint)
  (buyer-1-salt uint)
  (buyer-1-expiration uint)
  (buyer-1-signature (buff 65))
  ;; Buyer 2 (taker order)
  (buyer-2 principal)
  (buyer-2-maker-position-id (buff 32))
  (buyer-2-taker-position-id (buff 32))
  (buyer-2-amount uint)
  (buyer-2-payment uint)
  (buyer-2-salt uint)
  (buyer-2-expiration uint)
  (buyer-2-signature (buff 65))
  ;; Shared params
  (condition-id (buff 32))
  (fill-amount uint)
)
  (begin
    ;; Validate principals and buffers
    (asserts! (is-standard buyer-1) ERR-NOT-AUTHORIZED)
    (asserts! (is-standard buyer-2) ERR-NOT-AUTHORIZED)
    (asserts! (is-eq (len buyer-1-maker-position-id) u32) ERR-INVALID-ORDER)
    (asserts! (is-eq (len buyer-1-taker-position-id) u32) ERR-INVALID-ORDER)
    (asserts! (is-eq (len buyer-2-maker-position-id) u32) ERR-INVALID-ORDER)
    (asserts! (is-eq (len buyer-2-taker-position-id) u32) ERR-INVALID-ORDER)
    (asserts! (is-eq (len buyer-1-signature) u65) ERR-INVALID-SIGNATURE)
    (asserts! (is-eq (len buyer-2-signature) u65) ERR-INVALID-SIGNATURE)
    (asserts! (> buyer-1-amount u0) ERR-INVALID-AMOUNTS)
    (asserts! (> buyer-2-amount u0) ERR-INVALID-AMOUNTS)
    (asserts! (> buyer-1-payment u0) ERR-INVALID-AMOUNTS)
    (asserts! (> buyer-2-payment u0) ERR-INVALID-AMOUNTS)
    (asserts! (> fill-amount u0) ERR-INVALID-AMOUNTS)
    (asserts! (<= fill-amount buyer-1-amount) ERR-INVALID-AMOUNTS)
    (asserts! (<= fill-amount buyer-2-amount) ERR-INVALID-AMOUNTS)
    (asserts! (is-eq (len condition-id) u32) ERR-INVALID-ORDER)
    (asserts! (> buyer-1-expiration burn-block-height) ERR-ORDER-EXPIRED)
    (asserts! (> buyer-2-expiration burn-block-height) ERR-ORDER-EXPIRED)
    (asserts! (not (var-get is-paused)) ERR-PAUSED)

    (let
      (
        (order-1-hash (hash-order
          buyer-1
          buyer-1-maker-position-id
          buyer-1-taker-position-id
          buyer-1-amount
          buyer-1-payment
          buyer-1-salt
          buyer-1-expiration
        ))
        (order-2-hash (hash-order
          buyer-2
          buyer-2-maker-position-id
          buyer-2-taker-position-id
          buyer-2-amount
          buyer-2-payment
          buyer-2-salt
          buyer-2-expiration
        ))
        (total-payment (+ buyer-1-payment buyer-2-payment))
        (fee (calculate-fee fill-amount))
        (required (+ fill-amount fee))
      )
      ;; Verify signatures
      (asserts! (verify-signature order-1-hash buyer-1-signature buyer-1) ERR-INVALID-SIGNATURE)
      (asserts! (verify-signature order-2-hash buyer-2-signature buyer-2) ERR-INVALID-SIGNATURE)
      ;; Ensure collateral covers mint + fee exactly
      (asserts! (>= total-payment required) ERR-INVALID-AMOUNTS)

      ;; Deduct collateral from both buyers (reverts if insufficient)
      (unwrap! (deduct-collateral buyer-1 buyer-1-payment) ERR-INSUFFICIENT-COLLATERAL)
      (unwrap! (deduct-collateral buyer-2 buyer-2-payment) ERR-INSUFFICIENT-COLLATERAL)

      ;; Mint outcome tokens using collateral held by the contract
      (unwrap! (as-contract (contract-call? CTF_CONTRACT split-position
        fill-amount
        condition-id
      )) ERR-INSUFFICIENT-BALANCE)

      ;; Transfer minted tokens to buyers
      (unwrap! (as-contract (contract-call? CTF_CONTRACT safe-transfer-from
        (as-contract tx-sender)
        buyer-1
        buyer-1-taker-position-id
        fill-amount
      )) ERR-INSUFFICIENT-BALANCE)

      (unwrap! (as-contract (contract-call? CTF_CONTRACT safe-transfer-from
        (as-contract tx-sender)
        buyer-2
        buyer-2-taker-position-id
        fill-amount
      )) ERR-INSUFFICIENT-BALANCE)

      ;; Pay protocol fee out of remaining collateral (if any difference, credit back to buyer-1)
      (let ((overage (- total-payment required)))
        (if (> fee u0)
          (unwrap! (as-contract (contract-call? SBTC_TOKEN transfer
            fee
            tx-sender
            (var-get fee-receiver)
            none
          )) ERR-SBTC-TRANSFER-FAILED)
          true
        )
        (if (> overage u0)
          (credit-collateral buyer-1 overage)
          true
        )
      )

      (print {
        event: "order-filled-mint",
        buyer-1: buyer-1,
        buyer-2: buyer-2,
        condition-id: condition-id,
        fill-amount: fill-amount,
        buyer-1-payment: buyer-1-payment,
        buyer-2-payment: buyer-2-payment,
        fee: fee
      })
      (ok true)
    )
  )
)

;; Fill order via MERGE mode (both sellers)
;; Used when SELL YES + SELL NO orders match at complementary prices
;; Example: Alice SELL YES @ 0.35, Bob SELL NO @ 0.65
;;   - Take 100 YES from Alice, 100 NO from Bob
;;   - Call merge-positions(100) to burn and get 100 sBTC
;;   - Give Alice 35 sBTC, Bob 65 sBTC
(define-public (fill-order-merge
  ;; Seller 1 (e.g., selling YES)
  (seller-1 principal)
  (seller-1-position-id (buff 32))
  (seller-1-amount uint)
  (seller-1-payout uint)
  (seller-1-signature (buff 65))
  ;; Seller 2 (e.g., selling NO)
  (seller-2 principal)
  (seller-2-position-id (buff 32))
  (seller-2-amount uint)
  (seller-2-payout uint)
  (seller-2-signature (buff 65))
  ;; Shared params
  (condition-id (buff 32))
  (salt uint)
  (expiration uint)
  (fill-amount uint)
)
  (begin
    ;; Validate inputs
    (asserts! (is-standard seller-1) ERR-NOT-AUTHORIZED)
    (asserts! (is-standard seller-2) ERR-NOT-AUTHORIZED)
    (asserts! (is-eq (len seller-1-position-id) u32) ERR-INVALID-ORDER)
    (asserts! (is-eq (len seller-2-position-id) u32) ERR-INVALID-ORDER)
    (asserts! (is-eq (len condition-id) u32) ERR-INVALID-ORDER)
    (asserts! (> seller-1-amount u0) ERR-INVALID-AMOUNTS)
    (asserts! (> seller-2-amount u0) ERR-INVALID-AMOUNTS)
    (asserts! (> fill-amount u0) ERR-INVALID-AMOUNTS)
    (asserts! (<= fill-amount seller-1-amount) ERR-INVALID-AMOUNTS)
    (asserts! (<= fill-amount seller-2-amount) ERR-INVALID-AMOUNTS)
    (asserts! (> expiration burn-block-height) ERR-ORDER-EXPIRED)
    (asserts! (not (var-get is-paused)) ERR-PAUSED)

    (let
      (
        (total-payout (+ seller-1-payout seller-2-payout))
        (fee (calculate-fee total-payout))
        (payout-after-fee (- total-payout fee))
      )
      ;; Check sellers have the tokens
      (asserts! (>= (contract-call? CTF_CONTRACT balance-of seller-1 seller-1-position-id) fill-amount)
        ERR-INSUFFICIENT-BALANCE)
      (asserts! (>= (contract-call? CTF_CONTRACT balance-of seller-2 seller-2-position-id) fill-amount)
        ERR-INSUFFICIENT-BALANCE)

      ;; Transfer outcome tokens from both sellers to this contract
      (unwrap! (as-contract (contract-call? CTF_CONTRACT safe-transfer-from
        seller-1
        (as-contract tx-sender)
        seller-1-position-id
        fill-amount
      )) ERR-INSUFFICIENT-BALANCE)

      (unwrap! (as-contract (contract-call? CTF_CONTRACT safe-transfer-from
        seller-2
        (as-contract tx-sender)
        seller-2-position-id
        fill-amount
      )) ERR-INSUFFICIENT-BALANCE)

      ;; Merge positions to recover sBTC
      (unwrap! (as-contract (contract-call? CTF_CONTRACT merge-positions
        fill-amount
        condition-id
        (as-contract tx-sender)
      )) ERR-INSUFFICIENT-BALANCE)

      ;; Pay sellers their share
      (unwrap! (as-contract (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer
        (/ (* payout-after-fee seller-1-payout) total-payout)
        tx-sender
        seller-1
        none
      )) ERR-SBTC-TRANSFER-FAILED)

      (unwrap! (as-contract (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer
        (/ (* payout-after-fee seller-2-payout) total-payout)
        tx-sender
        seller-2
        none
      )) ERR-SBTC-TRANSFER-FAILED)

      ;; Transfer fee to receiver
      (if (> fee u0)
        (unwrap! (as-contract (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer
          fee
          tx-sender
          (var-get fee-receiver)
          none
        )) ERR-SBTC-TRANSFER-FAILED)
        true
      )

      (print {
        event: "order-filled-merge",
        seller-1: seller-1,
        seller-2: seller-2,
        seller-1-position-id: seller-1-position-id,
        seller-2-position-id: seller-2-position-id,
        fill-amount: fill-amount,
        total-payout: total-payout,
        fee: fee
      })
      (ok true)
    )
  )
)

;; Cancel an order (only maker can cancel)
(define-public (cancel-order
  (maker principal)
  (maker-position-id (buff 32))
  (taker-position-id (buff 32))
  (maker-amount uint)
  (taker-amount uint)
  (salt uint)
  (expiration uint)
)
  (begin
    ;; Validate inputs before using them
    (asserts! (is-standard maker) ERR-NOT-AUTHORIZED)
    (asserts! (is-eq (len maker-position-id) u32) ERR-INVALID-ORDER)
    (asserts! (is-eq (len taker-position-id) u32) ERR-INVALID-ORDER)
    (asserts! (> maker-amount u0) ERR-INVALID-AMOUNTS)
    (asserts! (> taker-amount u0) ERR-INVALID-AMOUNTS)
    (asserts! (> expiration burn-block-height) ERR-ORDER-EXPIRED)
    (asserts! (>= salt u0) ERR-INVALID-ORDER)
    (let
      (
        (order-hash (hash-order maker maker-position-id taker-position-id maker-amount taker-amount salt expiration))
      )
      (asserts! (is-eq contract-caller maker) ERR-NOT-AUTHORIZED)
      (asserts! (is-none (map-get? cancelled-orders { order-hash: order-hash })) ERR-ORDER-CANCELLED)

      (ok (map-set cancelled-orders
        { order-hash: order-hash }
        { cancelled: true }
      ))
    )
  )
)

;; Emergency pause (only owner)
(define-public (set-paused (paused bool))
  (begin
    (asserts! (is-eq tx-sender CONTRACT_OWNER) ERR-NOT-AUTHORIZED)
    (ok (var-set is-paused paused))
  )
)

;; Update fee receiver (only owner)
(define-public (set-fee-receiver (new-receiver principal))
  (begin
    (asserts! (is-eq tx-sender CONTRACT_OWNER) ERR-NOT-AUTHORIZED)
    (asserts! (is-standard new-receiver) ERR-NOT-AUTHORIZED)
    (ok (var-set fee-receiver new-receiver))
  )
)

;; Read-only functions

(define-read-only (get-filled-amount (order-hash (buff 32)))
  (if (is-eq (len order-hash) u32)
    (default-to u0 (get filled-amount (map-get? filled-orders { order-hash: order-hash })))
    u0
  )
)

(define-read-only (is-order-cancelled (order-hash (buff 32)))
  (if (is-eq (len order-hash) u32)
    (default-to false (get cancelled (map-get? cancelled-orders { order-hash: order-hash })))
    false
  )
)

(define-read-only (get-fee-receiver)
  (var-get fee-receiver)
)

(define-read-only (get-is-paused)
  (var-get is-paused)
)

(define-read-only (get-fee-bps)
  FEE_BPS
)
