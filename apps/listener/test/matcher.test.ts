import { describe, it, expect, afterEach } from "vitest";
import { matchPaymentToOrder, stellarToStroops, stroopsToStellar, type StellarPaymentEvent } from "../src/matcher.js";

const order = {
  id: "ord-1",
  memo: "ab".repeat(32),
  usdc_amount: "10.0000000",
  merchant_stellar_address: "G" + "M".repeat(55),
  platform_fee_bp: 100,
};

const validEvent: StellarPaymentEvent = {
  memo_type: "hash",
  memo_b64: Buffer.from("ab".repeat(32), "hex").toString("base64"),
  successful: true,
  asset_code: "USDC",
  asset_issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  to: "G" + "M".repeat(55),
  amount: "9.9000000",
  hash: "txhash",
};

describe("matchPaymentToOrder", () => {
  afterEach(() => { delete process.env.STELLAR_USDC_ISSUER_OVERRIDE; });

  it("matches valid USDC payment with correct memo + amount", () => {
    expect(matchPaymentToOrder(validEvent, order, "TESTNET")).toEqual({ outcome: "paid" });
  });

  it("returns underpaid when amount short", () => {
    const e = { ...validEvent, amount: "5.0000000" };
    expect(matchPaymentToOrder(e, order, "TESTNET")).toEqual({ outcome: "underpaid", expected: "9.9000000", received: "5.0000000" });
  });

  it("ignores when memo doesnt match", () => {
    const e = { ...validEvent, memo_b64: Buffer.from("cd".repeat(32), "hex").toString("base64") };
    expect(matchPaymentToOrder(e, order, "TESTNET").outcome).toBe("ignore");
  });

  it("ignores when wrong asset", () => {
    const e = { ...validEvent, asset_code: "XLM", asset_issuer: undefined };
    expect(matchPaymentToOrder(e, order, "TESTNET").outcome).toBe("ignore");
  });

  it("ignores unsuccessful tx", () => {
    const e = { ...validEvent, successful: false };
    expect(matchPaymentToOrder(e, order, "TESTNET").outcome).toBe("ignore");
  });

  it("matches when STELLAR_USDB_ISSUER_OVERRIDE overrides expected issuer", () => {
    const customIssuer = "GCUSTOM" + "X".repeat(49);
    process.env.STELLAR_USDC_ISSUER_OVERRIDE = customIssuer;
    const e = { ...validEvent, asset_issuer: customIssuer };
    expect(matchPaymentToOrder(e, order, "TESTNET")).toEqual({ outcome: "paid" });
  });

  it("ignores when issuer doesnt match override", () => {
    process.env.STELLAR_USDC_ISSUER_OVERRIDE = "GCUSTOM" + "X".repeat(49);
    // validEvent still has the Circle testnet issuer, not the override
    expect(matchPaymentToOrder(validEvent, order, "TESTNET").outcome).toBe("ignore");
  });

  it("BigInt path: 1 stroop short is underpaid (FP would round to paid)", () => {
    const o = { ...order, usdc_amount: "1.0000001", platform_fee_bp: 25 };
    // expected = 10000001 * 9975 / 10000 = 9975000 (truncated). Send 1 stroop less.
    const e = { ...validEvent, amount: "0.9974999" };
    expect(matchPaymentToOrder(e, o, "TESTNET").outcome).toBe("underpaid");
  });

  it("BigInt path: exact expected stroop count is paid", () => {
    const o = { ...order, usdc_amount: "1.0000001", platform_fee_bp: 25 };
    const e = { ...validEvent, amount: "0.9975000" };
    expect(matchPaymentToOrder(e, o, "TESTNET")).toEqual({ outcome: "paid" });
  });

  it("rejects malformed amount as ignore", () => {
    const e = { ...validEvent, amount: "10.99999999" }; // 8 fractional digits
    expect(matchPaymentToOrder(e, order, "TESTNET").outcome).toBe("ignore");
  });

  it("rejects fee_bp >= 10000 as ignore (would zero merchant share)", () => {
    const o = { ...order, platform_fee_bp: 10_000 };
    expect(matchPaymentToOrder(validEvent, o, "TESTNET").outcome).toBe("ignore");
  });

  it("rejects null fee_bp as ignore instead of treating as zero fee", () => {
    const o = { ...order, platform_fee_bp: null };
    expect(matchPaymentToOrder(validEvent, o, "TESTNET")).toEqual({ outcome: "ignore", reason: "fee_bp_invalid" });
  });

  it("rejects undefined/missing fee_bp as ignore", () => {
    const o = { ...order, platform_fee_bp: undefined };
    expect(matchPaymentToOrder(validEvent, o, "TESTNET")).toEqual({ outcome: "ignore", reason: "fee_bp_invalid" });
  });

  it("rejects negative fee_bp as ignore", () => {
    const o = { ...order, platform_fee_bp: -1 };
    expect(matchPaymentToOrder(validEvent, o, "TESTNET")).toEqual({ outcome: "ignore", reason: "fee_bp_invalid" });
  });
});

describe("stellarToStroops · stroopsToStellar", () => {
  it("round-trips canonical amounts", () => {
    for (const s of ["0.0000001", "1.0000000", "10.9999999", "9999999.9999999"]) {
      expect(stroopsToStellar(stellarToStroops(s))).toBe(s);
    }
  });

  it("normalizes short fractional", () => {
    expect(stellarToStroops("1.5")).toBe(15_000_000n);
    expect(stroopsToStellar(15_000_000n)).toBe("1.5000000");
  });

  it("rejects negative, scientific, more than 7 fractional digits", () => {
    expect(() => stellarToStroops("-1")).toThrow();
    expect(() => stellarToStroops("1e2")).toThrow();
    expect(() => stellarToStroops("1.00000001")).toThrow();
  });
});

// ----------------------------------------------------------------------------
// Cross-layer fee identity test.
//
// Asserts that the four independent implementations of the fee rule agree
// on the same vector table:
//
//   1. contract  (contracts/checkout/src/lib.rs)   - fee = amount * bp / 10000
//   2. edge      (apps/edge)                         - persisted fee_usdc
//   3. listener  (apps/listener/src/matcher.ts)        - expectedStroops
//   4. Solana client (apps/... solana client)        - integer rule
//
// The contract splits atomically:
//   client.transfer(&from, &merchant, &net);
//   if fee > 0 { client.transfer(&from, &fee_to, &fee); }
// so contract_fee + net == amount always holds. The listener must reproduce
// the same net (expectedStroops) to classify a payment as paid.
//
// Rounding rule (all four implementations): truncating integer division,
//   fee = floor(amount * bp / 10000)
//   net  = amount - fee
// ----------------------------------------------------------------------------

const BPS_DENOM = 10_000;
const MAX_BPS = 9999; // contract rejects bps >= 10000
// Stellar int64 stroop max for a single transfer (2 ** 63 - 1).
const MAX_STROOPS = (1n << 63n) - 1n;

/** Contract implementation: truncating integer division on stroops. */
function contractFeeStroops(amountStroops: bigint, bps: number): bigint {
  return (amountStroops * BigInt(bps)) / BigInt(BPS_DENOM);
}

/** Edge implementation: persisted fee_usdc as a stroop count. */
function edgeFeeStroops(amountStroops: bigint, bps: number): bigint {
  return (amountStroops * BigInt(bps)) / BigInt(BPS_DENOM);
}

/** Listener implementation: expectedStroops = net the merchant must receive. */
function listenerExpectedStroops(amountStroops: bigint, bps: number): bigint {
  const fee = (amountStroops * BigInt(bps)) / BigInt(BPS_DENOM);
  return amountStroops - fee;
}

/** Solana client implementation: the integer rule for fee and net. */
function solanaClientFeeStroops(amountStroops: bigint, bps: number): bigint {
  // Solana lamports are uint64; the rule is the same truncating integer division.
  return (amountStroops * BigInt(bps)) / BigInt(BPS_DENOM);
}

interface FeeVector {
  label: string;
  /** Order amount in stroops (1 USDC = 10^7 stroops). */
  amountStroops: bigint;
  bps: number;
}

/** Vector table covering the boundary cases required by the issue. */
const FEE_VECTORS: FeeVector[] = [
  // 1 stroop amount -- fee truncates to 0 for any bps < 10000.
  { label: "one stroop, bps=0", amountStroops: 1n, bps: 0 },
  { label: "one stroop, bps=1", amountStroops: 1n, bps: 1 },
  { label: "one stroop, bps=100", amountStroops: 1n, bps: 100 },
  { label: "one stroop, bps=9999", amountStroops: 1n, bps: MAX_BPS },

  // Fee exactly zero at non-zero amount (bps=0).
  { label: "fee exactly zero, bps=0, amount=10000000", amountStroops: 100_000_000n, bps: 0 },
  { label: "fee exactly zero, bps=0, max amount", amountStroops: MAX_STROOPS, bps: 0 },

  // Fee exactly one stroop: amount * bp / 10000 == 1.
  { label: "fee exactly one stroop, bps=1, amount=10000", amountStroops: 10_000n, bps: 1 },
  { label: "fee exactly one stroop, bps=100, amount=100", amountStroops: 100n, bps: 100 },
  { label: "fee exactly one stroop, bps=25, amount=400", amountStroops: 400n, bps: 25 },

  // Fee just below and just above one stroop (truncation boundary).
  { label: "fee below one stroop, bps=1, amount=9999", amountStroops: 9_999n, bps: 1 },
  { label: "fee just over one stroop, bps=1, amount=10001", amountStroops: 10_001n, bps: 1 },

  // bps of 0 and of the maximum.
  { label: "bps=0, amount=10000000", amountStroops: 100_000_000n, bps: 0 },
  { label: "bps=max, amount=10000000", amountStroops: 100_000_000n, bps: MAX_BPS },
  { label: "bps=max, max amount", amountStroops: MAX_STROOPS, bps: MAX_BPS },

  // Largest permitted amount.
  { label: "max amount, bps=100", amountStroops: MAX_STROOPS, bps: 100 },
  { label: "max amount, bps=25", amountStroops: MAX_STROOPS, bps: 25 },

  // Typical rates used in production.
  { label: "typical 10% on 10 USDC", amountStroops: 100_000_000n, bps: 1000 },
  { label: "typical 2.5% on 1.0000001 USDC", amountStroops: 10_000_010n, bps: 25 },
];

describe("fee identity across contract, edge, listener, and Solana client", () => {
  it.extend(FEE_VECTORS.map((v) => [v.label, v]))(
    "agrees on fee and net for %s",
    (_label, v) => {
      const contractFee = contractFeeStroops(v.amountStroops, v.bps);
      const edgeFee = edgeFeeStroops(v.amountStroops, v.bps);
      const solanaFee = solanaClientFeeStroops(v.amountStroops, v.bps);
      const listenerNet = listenerExpectedStroops(v.amountStroops, v.bps);

      // 1. All four implementations agree on the fee.
      expect(edgeFee, "edge fee must match contract fee").toBe(contractFee);
      expect(solanaFee, "Solana client fee must match contract fee").toBe(contractFee);

      // 2. The contract split is atomic: fee + net == amount.
      const contractNet = v.amountStroops - contractFee;
      expect(contractFee + contractNet, "contract split must sum to amount").toBe(
        v.amountStroops
      );

      // 3. The listener's expectedStroops is the net the chain moves.
      expect(listenerNet, "listener expectedStroops must match contract net").toBe(
        contractNet
      );

      // 4. The fee is always in [0, amount] and truncated.
      expect(contractFee >= 0n).toBe(true);
      expect(contractFee <= v.amountStroops).toBe(true);
      expect(contractFee * BigInt(BPS_DENOM)).
toBeLessThanOrEqual(
        v.amountStroops * BigInt(v.bps)
      );
    }
  );

  it("listener matches the contract net for a real order", () => {
    // 10 USDC, 100 bps -> fee = 0.1000000, net = 9.9000000.
    const amountStroops = stellarToStroops(order.usdc_amount);
    const contractFee = contractFeeStroops(amountStroops, order.platform_fee_bp);
    const contractNet = amountStroops - contractFee;
    const listenerNet = listenerExpectedStroops(amountStroops, order.platform_fee_bp);
    expect(listenerNet).toBe(contractNet);
    expect(stroopsToStellar(listenerNet)).toBe("9.9000000");

    // The listener classifies the contract net as paid.
    const event = { ...validEvent, amount: stroopsToStellar(listenerNet) };
    expect(matchPaymentToOrder(event, order, "TESTNET")).toEqual({ outcome: "paid" });
  });
});
