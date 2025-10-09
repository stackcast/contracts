;; Optimistic Oracle
;; UMA-style optimistic oracle with dispute resolution
;; Proposers bond tokens, disputers can challenge, DVM votes resolve

;; Error codes
(define-constant ERR-NOT-AUTHORIZED (err u200))
(define-constant ERR-INVALID-QUESTION (err u201))
(define-constant ERR-ALREADY-PROPOSED (err u202))
(define-constant ERR-NO-PROPOSAL (err u203))
(define-constant ERR-CHALLENGE-WINDOW-CLOSED (err u204))
(define-constant ERR-CHALLENGE-WINDOW-OPEN (err u205))
(define-constant ERR-ALREADY-DISPUTED (err u206))
(define-constant ERR-NOT-DISPUTED (err u207))
(define-constant ERR-ALREADY-RESOLVED (err u208))
(define-constant ERR-INSUFFICIENT-BOND (err u209))
(define-constant ERR-ALREADY-VOTED (err u210))
(define-constant ERR-VOTING-NOT-ACTIVE (err u211))

;; Constants
(define-constant CHALLENGE_WINDOW u144) ;; ~24 hours in blocks (10min blocks)
(define-constant VOTING_PERIOD u288) ;; ~48 hours in blocks
(define-constant BOND_AMOUNT u100000000) ;; 100 tokens (6 decimals)

;; Question states
(define-constant STATE-PROPOSED u1)
(define-constant STATE-DISPUTED u2)
(define-constant STATE-VOTING u3)
(define-constant STATE-RESOLVED u4)

;; Data structures

(define-map questions
  { question-id: (buff 32) }
  {
    requester: principal,
    question: (string-utf8 256),
    reward: uint,
    timestamp: uint,
    state: uint
  }
)

(define-map proposals
  { question-id: (buff 32) }
  {
    proposer: principal,
    proposed-answer: uint, ;; 0 = NO, 1 = YES
    bond: uint,
    proposal-time: uint
  }
)

(define-map disputes
  { question-id: (buff 32) }
  {
    disputer: principal,
    bond: uint,
    dispute-time: uint
  }
)

;; Voting data
(define-map votes
  { question-id: (buff 32), voter: principal }
  {
    vote: uint, ;; 0 = NO, 1 = YES
    stake: uint
  }
)

(define-map vote-tallies
  { question-id: (buff 32) }
  {
    yes-votes: uint,
    no-votes: uint,
    voting-ends: uint
  }
)

(define-map resolutions
  { question-id: (buff 32) }
  {
    final-answer: uint,
    resolved-at: uint
  }
)

;; Mock governance token for voting (in production, use real token)
(define-fungible-token oracle-token)

;; Initialize a new question
(define-public (initialize-question
  (question-id (buff 32))
  (question (string-utf8 256))
  (reward uint)
)
  (begin
    (asserts! (is-none (map-get? questions { question-id: question-id })) ERR-INVALID-QUESTION)
    (ok (map-set questions
      { question-id: question-id }
      {
        requester: tx-sender,
        question: question,
        reward: reward,
        timestamp: stacks-block-height,
        state: STATE-PROPOSED
      }
    ))
  )
)

;; Propose an answer (requires bond)
(define-public (propose-answer
  (question-id (buff 32))
  (proposed-answer uint)
)
  (let
    (
      (question (unwrap! (map-get? questions { question-id: question-id }) ERR-INVALID-QUESTION))
    )
    (asserts! (is-none (map-get? proposals { question-id: question-id })) ERR-ALREADY-PROPOSED)

    ;; Lock proposer's bond (in production, transfer from SIP-010 token)
    (try! (ft-mint? oracle-token BOND_AMOUNT tx-sender))

    (map-set proposals
      { question-id: question-id }
      {
        proposer: tx-sender,
        proposed-answer: proposed-answer,
        bond: BOND_AMOUNT,
        proposal-time: stacks-block-height
      }
    )

    (print {
      event: "answer-proposed",
      question-id: question-id,
      proposer: tx-sender,
      answer: proposed-answer
    })
    (ok true)
  )
)

;; Dispute a proposal (requires matching bond)
(define-public (dispute-proposal (question-id (buff 32)))
  (let
    (
      (question (unwrap! (map-get? questions { question-id: question-id }) ERR-INVALID-QUESTION))
      (proposal (unwrap! (map-get? proposals { question-id: question-id }) ERR-NO-PROPOSAL))
    )
    (asserts! (is-none (map-get? disputes { question-id: question-id })) ERR-ALREADY-DISPUTED)
    (asserts!
      (< stacks-block-height (+ (get proposal-time proposal) CHALLENGE_WINDOW))
      ERR-CHALLENGE-WINDOW-CLOSED
    )

    ;; Lock disputer's bond
    (try! (ft-mint? oracle-token BOND_AMOUNT tx-sender))

    ;; Update question state to DISPUTED
    (map-set questions
      { question-id: question-id }
      (merge question { state: STATE-DISPUTED })
    )

    (map-set disputes
      { question-id: question-id }
      {
        disputer: tx-sender,
        bond: BOND_AMOUNT,
        dispute-time: stacks-block-height
      }
    )

    ;; Initialize voting
    (map-set vote-tallies
      { question-id: question-id }
      {
        yes-votes: u0,
        no-votes: u0,
        voting-ends: (+ stacks-block-height VOTING_PERIOD)
      }
    )

    (map-set questions
      { question-id: question-id }
      (merge question { state: STATE-VOTING })
    )

    (print {
      event: "proposal-disputed",
      question-id: question-id,
      disputer: tx-sender
    })
    (ok true)
  )
)

;; Vote on disputed question (requires stake)
(define-public (vote
  (question-id (buff 32))
  (vote-value uint)
  (stake uint)
)
  (let
    (
      (question (unwrap! (map-get? questions { question-id: question-id }) ERR-INVALID-QUESTION))
      (tally (unwrap! (map-get? vote-tallies { question-id: question-id }) ERR-NOT-DISPUTED))
    )
    (asserts! (is-eq (get state question) STATE-VOTING) ERR-VOTING-NOT-ACTIVE)
    (asserts! (< stacks-block-height (get voting-ends tally)) ERR-CHALLENGE-WINDOW-CLOSED)
    (asserts! (is-none (map-get? votes { question-id: question-id, voter: tx-sender })) ERR-ALREADY-VOTED)

    ;; Lock voter's stake
    (try! (ft-mint? oracle-token stake tx-sender))

    ;; Record vote
    (map-set votes
      { question-id: question-id, voter: tx-sender }
      {
        vote: vote-value,
        stake: stake
      }
    )

    ;; Update tally
    (if (is-eq vote-value u1)
      (map-set vote-tallies
        { question-id: question-id }
        (merge tally { yes-votes: (+ (get yes-votes tally) stake) })
      )
      (map-set vote-tallies
        { question-id: question-id }
        (merge tally { no-votes: (+ (get no-votes tally) stake) })
      )
    )

    (print {
      event: "vote-cast",
      question-id: question-id,
      voter: tx-sender,
      vote: vote-value,
      stake: stake
    })
    (ok true)
  )
)

;; Resolve after voting period or challenge window
(define-public (resolve (question-id (buff 32)))
  (let
    (
      (question (unwrap! (map-get? questions { question-id: question-id }) ERR-INVALID-QUESTION))
      (proposal (unwrap! (map-get? proposals { question-id: question-id }) ERR-NO-PROPOSAL))
    )
    (asserts! (not (is-eq (get state question) STATE-RESOLVED)) ERR-ALREADY-RESOLVED)

    (let
      (
        (final-answer
          (if (is-some (map-get? disputes { question-id: question-id }))
            ;; If disputed, use voting result
            (let
              (
                (tally (unwrap-panic (map-get? vote-tallies { question-id: question-id })))
              )
              (asserts! (>= stacks-block-height (get voting-ends tally)) ERR-VOTING-NOT-ACTIVE)
              (if (> (get yes-votes tally) (get no-votes tally))
                u1
                u0
              )
            )
            ;; If not disputed, use proposal after challenge window
            (begin
              (asserts!
                (>= stacks-block-height (+ (get proposal-time proposal) CHALLENGE_WINDOW))
                ERR-CHALLENGE-WINDOW-OPEN
              )
              (get proposed-answer proposal)
            )
          )
        )
      )

      ;; Mark as resolved
      (map-set resolutions
        { question-id: question-id }
        {
          final-answer: final-answer,
          resolved-at: stacks-block-height
        }
      )

      (map-set questions
        { question-id: question-id }
        (merge question { state: STATE-RESOLVED })
      )

      ;; Handle rewards/slashing (simplified - in production, distribute to correct voters)
      (if (is-some (map-get? disputes { question-id: question-id }))
        (let
          (
            (dispute (unwrap-panic (map-get? disputes { question-id: question-id })))
          )
          ;; If disputer was correct, slash proposer
          (if (not (is-eq final-answer (get proposed-answer proposal)))
            (try! (ft-burn? oracle-token BOND_AMOUNT (get proposer proposal)))
            ;; If proposer was correct, slash disputer
            (try! (ft-burn? oracle-token BOND_AMOUNT (get disputer dispute)))
          )
        )
        true
      )

      (print {
        event: "question-resolved",
        question-id: question-id,
        final-answer: final-answer
      })
      (ok final-answer)
    )
  )
)

;; Read-only functions

(define-read-only (get-question (question-id (buff 32)))
  (map-get? questions { question-id: question-id })
)

(define-read-only (get-proposal (question-id (buff 32)))
  (map-get? proposals { question-id: question-id })
)

(define-read-only (get-dispute (question-id (buff 32)))
  (map-get? disputes { question-id: question-id })
)

(define-read-only (get-resolution (question-id (buff 32)))
  (map-get? resolutions { question-id: question-id })
)

(define-read-only (get-vote-tally (question-id (buff 32)))
  (map-get? vote-tallies { question-id: question-id })
)

(define-read-only (get-user-vote (question-id (buff 32)) (voter principal))
  (map-get? votes { question-id: question-id, voter: voter })
)

(define-read-only (is-resolved (question-id (buff 32)))
  (is-some (map-get? resolutions { question-id: question-id }))
)

(define-read-only (get-final-answer (question-id (buff 32)))
  (match (map-get? resolutions { question-id: question-id })
    resolution (some (get final-answer resolution))
    none
  )
)
