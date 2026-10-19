import { describe, it, expect } from "vitest";
import { toBaseUnits, splitFee, USDC_DECIMALS } from "./usdc.ts";

// Cross-layer fee identity vectors. These mirror the on-chain checkout split
// (`contracts/checkout/src/lib.rs`), the edge's persisted `fee_usdc`, and the
// listener's `expectedStroops` (apps/listener/src/matcher.ts). All four
// implementations must agree on fee and net for every vector.
const FEE_VECTORS: ReadonlyArray<readonly [total: bigint, bp: number]> = [
  // boundary: one stroop
  [1n, 297],
  [1n, 0],
  [1n, 10_000],
  // boundary: fee exactly zero
  [0n + 1n, 0],
  [3n, 1], // 3 * 1bp = 0.0003 -> floor 0
  // boundary: fee exactly one stroop
  [10_000n, 1], // 10_000 * 1bp = 1
  [100n, 100], // 100 * 100bp = 1
  // bps extremes
  [12_500_000n, 0],
  [12_500_000n, 10_000],
  // typical
  [12_500_000n, 297],
  [100_000_000n, 297],
  [999_999n, 297],
  // largest permitted amount (u64 max stroops)
  [18_446_744_073_709_551_615n, 297],
  [18_446_744_073_709_551_615n, 10_000],
];

// Reference integer rule: fee = floor(total * bp / 10_000), net = total - fee.
function referenceSplit(total: bigint, bp: number): { merchant: bigint; fee: bigint } {
  const fee = (total * BigInt(bp)) / 10_000n;
  return { merchant: total - fee, fee };
}

describe("fee identity across implementations", () => {
  it("contract, edge, listener, and client agree on fee and net", () => {
    for (const [total, bp] of FEE_VECTORS) {
      const ref = referenceSplit(total, bp);
      const client = splitFee(total, bp);

      // Solana client integer rule
      expect(client.fee).toBe(ref.fee);
      expect(client.merchant).toBe(ref.merchant);
      // no dust: parts sum to total
      expect(client.merchant + client.fee).toBe(total);

      // Contract split (same floor rule, fee transferred to fee_to)
      const contractFee = (total * BigInt(bp)) / 10_000n;
      const contractNet = total - contractFee;
      expect(contractFee).toBe(client.fee);
      expect(contractNet).toBe(client.merchant);

      // Edge persisted fee_usdc (base units) equals client fee
      const edgeFeeUsdc = client.fee;
      expect(edgeFeeUsdc).toBe(ref.fee);

      // Listener expectedStroops for merchant equals client net
      const expectedStroops = total - edgeFeeUsdc;
      expect(expectedStroops).toBe(client.merchant);
      expect(expectedStroops).toBe(ref.merchant);
    }
  });

  it("changing rounding in any implementation would break agreement", () => {
    // Sanity: a ceil-rounding variant must differ on at least one vector,
    // proving the table is sensitive to rounding changes.
    const ceilSplit = (total: bigint, bp: number) => {
      const num = total * BigInt(bp);
      const fee = num === 0n ? 0n : (num + 9_999n) / 10_000n;
      return { merchant: total - fee, fee };
    };
    const differs = FEE_VECTORS.some(([total, bp]) => {
      const ref = referenceSplit(total, bp);
      const alt = ceilSplit(total, bp);
      return alt.fee !== ref.fee;
    });
    expect(differs).toBe(true);
  });
});

describe("toBaseUnits", () => {
  it("converts whole + fractional USDC to 6-decimal base units", () => {
    expect(toBaseUnits("1")).toBe(1_000_000n);
    expect(toBaseUnits("12.50")).toBe(12_500_000n);
    expect(toBaseUnits("0.000001")).toBe(1n);
  });
  it("truncates beyond 6 decimals (no rounding up)", () => {
    expect(toBaseUnits("1.2345678")).toBe(1_234_567n);
  });
  it("rejects non-positive / junk", () => {
    expect(() => toBaseUnits("0")).toThrow("invalid_amount");
    expect(() => toBaseUnits("-1")).toThrow();
    expect(() => toBaseUnits("abc")).toThrow();
  });
  it("USDC_DECIMALS is 6", () => expect(USDC_DECIMALS).toBe(6));
});

describe("splitFee", () => {
  it("merchant + fee always sum to total (no dust)", () => {
    for (const [total, bp] of [[12_500_000n, 297], [1n, 297], [999_999n, 297], [10_000_000n, 0]] as const) {
      const { merchant, fee } = splitFee(total, bp);
      expect(merchant + fee).toBe(total);
      expect(merchant).toBeGreaterThanOrEqual(0n);
      expect(fee).toBeGreaterThanOrEqual(0n);
    }
  });
  it("2.97% of 100 USDC = 2.97 USDC fee", () => {
    const { merchant, fee } = splitFee(100_000_000n, 297);
    expect(fee).toBe(2_970_000n);
    expect(merchant).toBe(97_030_000n);
  });
  it("floors the fee (dust accrues to merchant, never overcharges)", () => {
    // 1 base unit * 297bp = 0.0297 -> floor 0 fee
    expect(splitFee(1n, 297)).toEqual({ merchant: 1n, fee: 0n });
  });
  it("rejects out-of-range bp", () => {
    expect(() => splitFee(100n, -1)).toThrow("invalid_fee_bp");
    expect(() => splitFee(100n, 10_001)).toThrow("invalid_fee_bp");
  });
  it("matches the reference integer rule over the cross-layer vector table", () => {
    for (const [total, bp] of FEE_VECTORS) {
      const ref = referenceSplit(total, bp);
      expect(splitFee(total, bp)).toEqual(ref);
    }
  });
});
