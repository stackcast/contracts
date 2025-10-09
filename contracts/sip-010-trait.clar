;; SIP-010 Fungible Token Standard Trait
;; Defines the standard interface for fungible tokens on Stacks

(define-trait sip-010-trait
  (
    ;; Transfer tokens from sender to recipient
    (transfer (uint principal principal (optional (buff 34))) (response bool uint))

    ;; Get token name
    (get-name () (response (string-ascii 32) uint))

    ;; Get token symbol
    (get-symbol () (response (string-ascii 32) uint))

    ;; Get number of decimals
    (get-decimals () (response uint uint))

    ;; Get balance of account
    (get-balance (principal) (response uint uint))

    ;; Get total token supply
    (get-total-supply () (response uint uint))

    ;; Get token URI
    (get-token-uri () (response (optional (string-utf8 256)) uint))
  )
)
