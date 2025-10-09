;; CTF Exchange
;; Settlement layer for prediction market trades
;; Matches off-chain orders and executes on-chain atomic swaps

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

;; Constants
(define-constant CONTRACT_OWNER tx-sender)
(define-constant FEE_BPS u50) ;; 0.5% fee (50 basis points)
(define-constant FEE_DENOMINATOR u10000)

;; Contract references
(define-constant CTF_CONTRACT .conditional-tokens)

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

;; Nonces for replay protection
(define-map nonces
  { user: principal }
  { nonce: uint }
)

;; Fee receiver
(define-data-var fee-receiver principal CONTRACT_OWNER)

;; Paused state for emergency
(define-data-var is-paused bool false)

;; Helper: Get nonce for user
(define-read-only (get-nonce (user principal))
  (default-to u0 (get nonce (map-get? nonces { user: user })))
)

;; Helper: Increment nonce
(define-private (increment-nonce (user principal))
  (let
    (
      (current-nonce (get-nonce user))
    )
    (map-set nonces
      { user: user }
      { nonce: (+ current-nonce u1) }
    )
  )
)

;; Helper: Compute order hash
(define-read-only (hash-order
  (maker principal)
  (taker principal)
  (position-id (buff 32))
  (maker-amount uint)
  (taker-amount uint)
  (salt uint)
  (expiration uint)
)
  (sha256 (concat
    (concat
      (concat
        (concat
          (concat
            (concat
              (unwrap-panic (to-consensus-buff? maker))
              (unwrap-panic (to-consensus-buff? taker))
            )
            position-id
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

;; Match and settle orders
;; This is called by the CLOB operator after matching orders off-chain
;; Simplified version: matches one maker order with one taker order
(define-public (fill-order
  ;; Maker order
  (maker principal)
  (maker-position-id (buff 32))
  (maker-amount uint)
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
  (let
    (
      (order-hash (hash-order maker taker maker-position-id maker-amount taker-amount salt expiration))
      (filled-amount (default-to u0 (get filled-amount (map-get? filled-orders { order-hash: order-hash }))))
      (fee (calculate-fee taker-amount))
    )
    ;; Checks
    (asserts! (not (var-get is-paused)) ERR-PAUSED)
    (asserts! (< stacks-block-height expiration) ERR-ORDER-EXPIRED)
    (asserts! (is-none (map-get? cancelled-orders { order-hash: order-hash })) ERR-ORDER-CANCELLED)
    (asserts! (< filled-amount maker-amount) ERR-ORDER-FILLED)
    (asserts! (> fill-amount u0) ERR-INVALID-AMOUNTS)
    (asserts! (<= (+ filled-amount fill-amount) maker-amount) ERR-INVALID-AMOUNTS)

    ;; In production, verify signatures here
    ;; For hackathon, we trust the caller (CLOB operator)

    ;; Calculate proportional taker amount
    (let
      (
        (proportional-taker-amount (/ (* taker-amount fill-amount) maker-amount))
      )

      ;; Execute the swap
      ;; 1. Transfer maker's position tokens to taker
      (unwrap! (contract-call? CTF_CONTRACT safe-transfer-from
        maker
        taker
        maker-position-id
        fill-amount
      ) ERR-INSUFFICIENT-BALANCE)

      ;; 2. Transfer taker's position tokens to maker (minus fee)
      (let
        (
          (taker-amount-after-fee (- proportional-taker-amount fee))
        )
        (unwrap! (contract-call? CTF_CONTRACT safe-transfer-from
          taker
          maker
          taker-position-id
          taker-amount-after-fee
        ) ERR-INSUFFICIENT-BALANCE)

        ;; 3. Transfer fee to fee receiver
        (if (> fee u0)
          (unwrap! (contract-call? CTF_CONTRACT safe-transfer-from
            taker
            (var-get fee-receiver)
            taker-position-id
            fee
          ) ERR-INSUFFICIENT-BALANCE)
          true
        )
      )

      ;; Update filled amount
      (map-set filled-orders
        { order-hash: order-hash }
        { filled-amount: (+ filled-amount fill-amount) }
      )

      ;; Increment nonces
      (increment-nonce maker)
      (increment-nonce taker)

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

;; Cancel an order (only maker can cancel)
(define-public (cancel-order
  (maker principal)
  (taker principal)
  (position-id (buff 32))
  (maker-amount uint)
  (taker-amount uint)
  (salt uint)
  (expiration uint)
)
  (let
    (
      (order-hash (hash-order maker taker position-id maker-amount taker-amount salt expiration))
    )
    (asserts! (is-eq tx-sender maker) ERR-NOT-AUTHORIZED)
    (asserts! (is-none (map-get? cancelled-orders { order-hash: order-hash })) ERR-ORDER-CANCELLED)

    (ok (map-set cancelled-orders
      { order-hash: order-hash }
      { cancelled: true }
    ))
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
    (ok (var-set fee-receiver new-receiver))
  )
)

;; Read-only functions

(define-read-only (get-filled-amount (order-hash (buff 32)))
  (default-to u0 (get filled-amount (map-get? filled-orders { order-hash: order-hash })))
)

(define-read-only (is-order-cancelled (order-hash (buff 32)))
  (default-to false (get cancelled (map-get? cancelled-orders { order-hash: order-hash })))
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
