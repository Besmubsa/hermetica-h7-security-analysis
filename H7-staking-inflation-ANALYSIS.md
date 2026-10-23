# H7 — USDh Staking Share-Price Inflation: Final Analysis (Executable PoC Verified)

**Status: CLOSED — theft primitive disproved at VM level. Residual impact: re-armable staking DoS/griefing (Low, not Immunefi-eligible).**
**Date: 2026-10-24 | Method: executable PoC on production code (clarinet simnet, repo HEAD == mainnet)**

This document supersedes `H7-staking-inflation-report-draft.md` (submission draft). The draft's
PoC math assumed that `ft-mint?` with amount 0 succeeds. Executable verification proved the
opposite, which collapses the theft chain. What remains is documented below with the same rigor.

---

## 1. Weakness (confirmed, real)

`staking-v1-1` prices shares from the **raw token balance** of `.staking-reserve-v1`:

```clarity
;; staking-v1-1.clar L21-37
(define-read-only (get-usdh-per-susdh)
  (let ((total-usdh-staked   (unwrap-panic (contract-call? .usdh-token get-balance .staking-reserve)))
        (total-susdh-supply  (unwrap-panic (contract-call? .susdh-token get-total-supply))))
    (ok (if (and (> total-usdh-staked u0) (> total-susdh-supply u0))
      (/ (* total-usdh-staked usdh-base) total-susdh-supply)
      usdh-base))))
```

There is no first-depositor protection: no virtual share offset, no minimum stake, no dead
shares. `usdh-token-v1::transfer` is a standard unrestricted SIP-010, so **anyone can donate
USDh directly to the reserve and inflate the exchange rate** (verified live in the PoC, phase P1).
The hBTC vault mitigates this same class via protocol-managed `total-assets` accounting plus
`check-max-deviation`; the staking pair has no equivalent.

## 2. The draft theft chain — and why it fails

Draft chain (pre-verification): attacker stakes 1 unit, donates D, victim stakes X ≤ D,
victim's shares floor to 0 (`mint(0)` "succeeds"), attacker unstakes and drains `1 + D + X`.

Empirical result (PoC phase P0/P2, see §4):

- **P0:** `usdh/susdh mint-for-protocol(0, ...)` → `(err u1)`. The Clarity VM **rejects
  zero-amount mints**. This is not a protocol guard — it is VM-level semantics.
- **P2:** victim `stake(X)` on the inflated pool → `(err u1)` (the zero mint inside `stake`),
  **the whole transaction reverts atomically, victim funds fully intact**.

Because a 0-share mint can never succeed, the "victim receives 0 shares" step is impossible
on this VM, and the full-drain theft chain is dead. The in-scope vault path
(`hermetica-interface-v1::hermetica-stake`) cannot reach its `susdh transfer(susdh-amount = 0)`
either: the internal `staking.stake()` reverts first (PoC note P3; additionally
`ft-transfer?(0)` → `(err u3)` — zero transfers are VM-rejected as well).

## 3. Best remaining theft variant — profitless

With `D = X − 1`, the victim mints exactly **1 share** (S = 1 boundary; the only S > 0 case
with maximal attacker pool share, 50%):

- Attacker payout after drain: `(1 + D + X) / 2 = (X − 1 − D) / 2 + (1 + D)`; net profit
  against the invested `1 + D` is exactly `(X − 1 − D) / 2 = 0`.
- PoC phase P2b: victim ends whole (`VICTIM_STAKE` fully recovered), attacker net profit
  measured **0 wei** on production code.

General S ≥ 1 variants are bounded by the same identity and are strictly non-profitable;
S = 0 is impossible (§2). **No profitable theft variant exists on this VM.**

## 4. Executable PoC (artifact)

`tests/hbtc/H7-poc-staking-inflation.test.ts` (in the target repo clone) — single deterministic
clarinet-simnet test against repo HEAD (byte-verified == mainnet during recon session 5).
Simnet-only config deltas, mirroring mainnet state: `.staking-silo` registered in the usdh-hq
protocol map (required by `staking-reserve-v1.transfer::check-is-protocol(recipient)`),
attacker EOA registered as minting-contract to obtain test USDh, custom cooldown 0 for the
attacker (mirrors owner-set `set-custom-cooldown`; default is 7 days).

Transcript:

```
[P0]  ft-mint?(0) via usdh.mint-for-protocol      -> (err u1)
[P1]  landmine refundable: attacker recovered donation in full
[P2]  victim stake(50,000 USDh) on inflated pool  -> (err u1)  [reverts; funds intact]
[P2]  attacker recovered 1 + D in full; landmine is re-armable at zero cost
[P2b] victim stake with D = X-1 (expect 1 share)  -> ok, exactly 1 share
[P2b] attacker net profit on S=1 variant: 0
[P3]  ft-transfer?(0) via susdh.transfer          -> (err u3)
```

## 5. Residual impact (what an attacker CAN do)

1. **Persistent staking DoS/griefing.** An armed landmine (stake 1 + donate D, then recover
   everything) reverts every `stake(X)` with `X ≤ D` until the pool's supply grows past the
   inflation. Re-arming is free (donation is fully refundable, PoC P1/P2). This can also
   grief the vault's yield strategy: trader `hermetica-stake` txs revert while armed.
2. **No fund loss.** Victim stakes revert atomically (funds intact); existing shareholders are
   untouched; the donation itself is recoverable. `staking-silo` claims pay fixed recipients.

Severity: **Low** (availability/griefing, no theft, no freezing). Additionally, the USDh staking
contracts are not in the program's visible asset list, and Immunefi's Primacy-of-Impact route
requires in-scope impact — a fee-free griefing on an out-of-list product does not qualify.
**Disposition: do not submit. Retain as hardening evidence.**

## 6. Recommended hardening (for the team, mirrors vault's own mitigations)

1. Price shares from a protocol-managed accounting variable (as `state-v1::total-assets` does)
   or add a virtual share offset (e.g., OpenZeppelin-style `mulDiv` virtual shares).
2. Enforce `min-stake` and/or mint dead shares at pool seeding.
3. Reject `stake` when computed `amount-susdh == 0` (defense-in-depth if the VM ever relaxes
   zero-mint semantics, and better UX than a raw revert).
4. Optionally gate direct USDh transfers into `.staking-reserve` (donation sink).

## 7. Evidence index

- `staking-v1-1.clar` L21–37 (raw-balance pricing), L43–58 (`stake`, floor to 0 possible),
  L60–75 (`unstake`, fixed-recipient claim).
- `usdh-token-v1.clar` L52–66 (unrestricted SIP-010 `transfer`), L90–96 (`mint-for-protocol`,
  no min-amount guard — the gate that matters is the VM's).
- `susdh-token-v1.clar` L139–145 (same mint shape), L65–89 (transfer).
- `staking-reserve-v1.clar` L11–17 (transfer gated on `check-is-protocol(recipient)`).
- `staking-silo-v1-1.clar` L75–93 (`create-claim` requires `amount > 0`).
- `hermetica-interface-v1.clar` L32–49 (`hermetica-stake`, in-scope entry).
- On-chain 2026-10-24 (Hiro API): staking-reserve = 0, staking-silo = 0, sUSDh supply = 0.
- PoC artifact: `tests/hbtc/H7-poc-staking-inflation.test.ts` — `1 passed`.
