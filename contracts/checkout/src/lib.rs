#![no_std]
//! SlipPay Checkout — the "Stripe of stablecoin" revenue primitive.
//!
//! A single, atomic payment that splits on-chain: the merchant receives the net,
//! SlipPay receives its fee — and the fee is INESCAPABLE. The fee recipient and
//! basis points are fixed at deploy (constructor) and read from storage on every
//! pay; the caller cannot route around them. Either both legs settle or none does.
//!
//! pay(from, merchant, token, amount):
//!   fee = amount * fee_bps / 10_000
//!   transfer(from -> merchant, amount - fee)
//!   transfer(from -> fee_to,   fee)
//!
//! `from.require_auth()` — the payer authorizes the whole charge once; the two
//! nested SEP-41 transfers settle atomically (Soroban reverts on any failure).

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, token, Address, Env, Symbol};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    BadConfig = 1,
    BadAmount = 2,
}

#[contracttype]
enum DataKey {
    FeeTo,
    FeeBps,
}

#[contract]
pub struct Checkout;

#[contractimpl]
impl Checkout {
    /// Set the SlipPay fee recipient + basis points once, at deploy. Immutable.
    pub fn __constructor(env: Env, fee_to: Address, fee_bps: u32) {
        if fee_bps > 10_000 {
            panic_with(&env, Error::BadConfig);
        }
        env.storage().instance().set(&DataKey::FeeTo, &fee_to);
        env.storage().instance().set(&DataKey::FeeBps, &fee_bps);
    }

    /// One charge → two atomic transfers: net to merchant, fee to SlipPay.
    pub fn pay(env: Env, from: Address, merchant: Address, token: Address, amount: i128) -> i128 {
        from.require_auth();
        if amount <= 0 {
            panic_with(&env, Error::BadAmount);
        }

        let fee_to: Address = env.storage().instance().get(&DataKey::FeeTo)
            .unwrap_or_else(|| panic_with(&env, Error::BadConfig));
        let fee_bps: u32 = env.storage().instance().get(&DataKey::FeeBps)
            .unwrap_or_else(|| panic_with(&env, Error::BadConfig));

        let fee: i128 = amount * (fee_bps as i128) / 10_000;
        let net: i128 = amount - fee;

        let client = token::Client::new(&env, &token);
        client.transfer(&from, &merchant, &net);
        if fee > 0 {
            client.transfer(&from, &fee_to, &fee);
        }

        env.events().publish(
            (Symbol::new(&env, "checkout_paid"), from),
            (merchant, amount, net, fee),
        );
        fee
    }

    pub fn fee_bps(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0)
    }
    pub fn fee_to(env: Env) -> Address {
        env.storage().instance().get(&DataKey::FeeTo).unwrap()
    }
}

fn panic_with(env: &Env, e: Error) -> ! {
    soroban_sdk::panic_with_error!(env, e)
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, token, Address, Env};

    /// The canonical fee rule shared by every layer: floor(amount * bps / 10_000).
    fn expected_fee(amount: i128, bps: u32) -> i128 {
        amount * (bps as i128) / 10_000
    }

    /// (amount, fee_bps) vectors covering the boundary cases from the issue.
    fn vectors() -> [(i128, u32); 10] {
        [
            (1, 0),          // one stroop, zero fee
            (1, 10_000),     // one stroop, max bps -> fee floors to 0
            (9_999, 1),      // fee exactly zero (floors)
            (10_000, 1),     // fee exactly one stroop
            (1_000_000, 0),  // bps of 0
            (1_000_000, 10_000), // bps of max -> fee == amount, net == 0
            (1_000_000, 250),    // 2.5%
            (123_456_789, 333),  // odd amount, odd bps
            (i128::MAX / 10_000, 10_000), // largest amount that cannot overflow
            (i128::MAX / 10_000, 1),      // largest amount, tiny bps
        ]
    }

    #[test]
    fn fee_identity_matches_on_chain_split() {
        let env = Env::default();
        env.mock_all_auths();

        let fee_to = Address::generate(&env);
        let from = Address::generate(&env);
        let merchant = Address::generate(&env);

        let token_id = env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
        let sac = token::StellarAssetClient::new(&env, &token_id);

        for (amount, bps) in vectors() {
            let contract_id = env.register(Checkout, (&fee_to, &bps));
            let client = CheckoutClient::new(&env, &contract_id);

            // Fund the payer with exactly `amount`.
            sac.mint(&from, &amount);

            let fee = client.pay(&from, &merchant, &token_id, &amount);

            let want_fee = expected_fee(amount, bps);
            let want_net = amount - want_fee;

            // Contract's returned fee matches the shared integer rule.
            assert_eq!(fee, want_fee, "contract fee mismatch for ({amount}, {bps})");

            // The chain actually moved exactly net to merchant and fee to fee_to.
            let tok = token::Client::new(&env, &token_id);
            assert_eq!(tok.balance(&merchant), want_net, "merchant net mismatch for ({amount}, {bps})");
            assert_eq!(tok.balance(&fee_to), want_fee, "fee_to mismatch for ({amount}, {bps})");
            assert_eq!(tok.balance(&from), 0, "payer not fully debited for ({amount}, {bps})");

            // Conservation: net + fee == amount.
            assert_eq!(want_net + want_fee, amount);
        }
    }
}
