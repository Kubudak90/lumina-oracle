// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {IERC20} from "../interfaces/IERC20.sol";
import {IDualOracle, IERC165} from "./interfaces/IDualOracle.sol";

/// @notice An 8-decimal USD price source (`LighterCorePriceSource` or `FixedPriceSource`).
interface ILighterPriceSource {
    function latestAnswer() external view returns (int256);
}

/// @notice The borrow guard (`LuminaPriceGuard`).
interface ILighterBorrowGuard {
    function isBorrowAllowed() external view returns (bool);
}

/// @title LighterDualOracle
/// @notice FraxLend `IDualOracle` for a Lumina isolated pair on Lighter.
///
/// Exchange rate = collateral units per asset unit × 1e18 (`ORACLE_PRECISION`), in the
/// `DualOracleChainlinkUniV3` normalization with both feeds at 8 decimals (multiply = asset USD
/// price, divide = collateral USD price):
///
///     rate = 1e36 × assetPrice / (collateralPrice × 10^(18 + assetDecimals − collateralDecimals))
///
/// computed with a single division. `getPrices()` returns `(isBadData, rate, rate)` with
/// `isBadData = !guard.isBorrowAllowed()`: the pair then blocks new borrows (and collateral
/// removal by borrowers) while repay, add-collateral, lending and liquidation keep working.
/// Keeper reference prices are never used in the rate: a compromised keeper can only set
/// `isBadData`, never move valuations. A failed source read reverts (no price, no fallback).
/// The guard is called last, low-level, with at most `GUARD_CALL_GAS`; any failure (revert,
/// out of gas, malformed return) counts as bad data, so a broken guard can block borrows but
/// never `getPrices()` (and so never liquidations). An answer other than "allowed" counts only
/// if the guard was given the full `GUARD_CALL_GAS`; with less, the caller may have starved it
/// (or a read inside it) on purpose, and a pair would cache that verdict for the whole block, so
/// the call reverts `InsufficientGasForGuard` instead (audit N-ORA-01). Callers that can reach
/// the guard (pair liquidations) must budget the full stipend on top of their own gas.
contract LighterDualOracle is IDualOracle {
    uint256 public constant override ORACLE_PRECISION = 1e18;
    uint8 internal constant DECIMALS = 18;
    uint256 internal constant MAX_TOKEN_DECIMALS = 18;
    /// @notice Gas forwarded to `GUARD.isBorrowAllowed()`. A guard needs one READ_CORE read per
    /// guarded market (≤ 8; a failed read burns its source's stipend, 100k by default).
    uint256 public constant GUARD_CALL_GAS = 1_000_000;
    /// @notice Gas kept back from the guard call so this oracle can always finish and return.
    uint256 public constant GUARD_GAS_RESERVE = 20_000;

    /// @notice Pair asset (FraxLend `BASE_TOKEN`) and collateral (`QUOTE_TOKEN`).
    address public immutable ASSET;
    address public immutable COLLATERAL;
    uint256 public immutable ASSET_DECIMALS;
    uint256 public immutable COLLATERAL_DECIMALS;

    ILighterPriceSource public immutable ASSET_PRICE_SOURCE;
    ILighterPriceSource public immutable COLLATERAL_PRICE_SOURCE;
    ILighterBorrowGuard public immutable GUARD;

    /// @notice 10^(18 + assetDecimals − collateralDecimals).
    uint256 public immutable RATE_NORMALIZATION;

    string private _name;

    error ZeroAddress();
    error UnsupportedDecimals();
    error InvalidSourcePrice(address source, int256 price);
    error ZeroRate();
    error InvalidGuard();
    error InsufficientGasForGuard();

    constructor(
        address asset,
        address collateral,
        ILighterPriceSource assetPriceSource,
        ILighterPriceSource collateralPriceSource,
        ILighterBorrowGuard guard,
        string memory name_
    ) {
        if (
            asset == address(0) || collateral == address(0) || address(assetPriceSource) == address(0)
                || address(collateralPriceSource) == address(0) || address(guard) == address(0)
        ) revert ZeroAddress();
        uint256 assetDecimals = IERC20(asset).decimals();
        uint256 collateralDecimals = IERC20(collateral).decimals();
        if (assetDecimals > MAX_TOKEN_DECIMALS || collateralDecimals > MAX_TOKEN_DECIMALS) {
            revert UnsupportedDecimals();
        }
        ASSET = asset;
        COLLATERAL = collateral;
        ASSET_DECIMALS = assetDecimals;
        COLLATERAL_DECIMALS = collateralDecimals;
        ASSET_PRICE_SOURCE = assetPriceSource;
        COLLATERAL_PRICE_SOURCE = collateralPriceSource;
        GUARD = guard;
        // Exponent >= 0 because both decimals are <= 18.
        RATE_NORMALIZATION = 10 ** (18 + assetDecimals - collateralDecimals);
        _name = name_;

        // Wiring checks: both sources must price now, and the guard must be a contract that
        // answers isBorrowAllowed() with a well-formed bool.
        _rate();
        if (address(guard).code.length == 0) revert InvalidGuard();
        (bool ok, bool valid,,) = _callGuard();
        if (!ok || !valid) revert InvalidGuard();
    }

    // --------------------------------------------------------------------------- prices

    /// @inheritdoc IDualOracle
    function getPrices() external view override returns (bool isBadData, uint256 priceLow, uint256 priceHigh) {
        uint256 rate = _rate(); // reverts without a price
        isBadData = _isBadData(); // never reverts
        return (isBadData, rate, rate);
    }

    /// @notice Same as `getPrices()` but in whole-token terms (1e18 = one collateral token per
    /// asset token): the rate divided by 10^NORMALIZATION when positive, else multiplied.
    function getPricesNormalized()
        external
        view
        override
        returns (bool isBadData, uint256 priceLow, uint256 priceHigh)
    {
        uint256 rate = _normalize(_rate());
        isBadData = _isBadData();
        return (isBadData, rate, rate);
    }

    function _rate() internal view returns (uint256 rate) {
        uint256 assetPrice = _read(ASSET_PRICE_SOURCE);
        uint256 collateralPrice = _read(COLLATERAL_PRICE_SOURCE);
        // Checked arithmetic: with realistic source bounds (MAX_PRICE ≪ 1e40) nothing overflows;
        // an absurd price reverts instead of wrapping.
        rate = (1e36 * assetPrice) / (collateralPrice * RATE_NORMALIZATION);
        if (rate == 0) revert ZeroRate();
    }

    function _read(ILighterPriceSource source) internal view returns (uint256) {
        int256 answer = source.latestAnswer();
        if (answer <= 0) revert InvalidSourcePrice(address(source), answer);
        return uint256(answer);
    }

    /// @dev Any guard failure counts as bad data, but only once the guard had the full
    /// `GUARD_CALL_GAS`: otherwise a not-allowed answer may be forged by withholding gas, so
    /// revert. An allowed answer is accepted at any gas.
    function _isBadData() internal view returns (bool) {
        (bool ok, bool valid, bool allowed, uint256 forwarded) = _callGuard();
        if (ok && valid && allowed) return false;
        if (forwarded < GUARD_CALL_GAS) revert InsufficientGasForGuard();
        return true;
    }

    /// @dev Forwards min(GUARD_CALL_GAS, gasleft − GUARD_GAS_RESERVE) and copies at most 32
    /// bytes of returndata, so neither a gas-burning nor an oversized response can starve this
    /// oracle (and the liquidation calling it). `valid` = exactly 32 bytes encoding 0 or 1.
    /// `forward` is the gas requested for the call; when it equals `GUARD_CALL_GAS` the guard
    /// receives all of it, because the reserve exceeds the 1/64 the call keeps back plus the
    /// cost of the call itself.
    function _callGuard() internal view returns (bool ok, bool valid, bool allowed, uint256 forward) {
        uint256 available = gasleft();
        if (available <= GUARD_GAS_RESERVE) return (false, false, false, 0);
        forward = available - GUARD_GAS_RESERVE;
        if (forward > GUARD_CALL_GAS) forward = GUARD_CALL_GAS;
        address guard = address(GUARD);
        bytes4 selector = ILighterBorrowGuard.isBorrowAllowed.selector;
        uint256 size;
        uint256 word;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, selector)
            ok := staticcall(forward, guard, ptr, 4, ptr, 32)
            size := returndatasize()
            word := mload(ptr)
        }
        if (!ok || size != 32 || word > 1) return (ok, false, false, forward);
        return (true, true, word == 1, forward);
    }

    function _normalize(uint256 rate) internal view returns (uint256) {
        int256 normalization = NORMALIZATION_0();
        if (normalization > 0) return rate / 10 ** uint256(normalization);
        return rate * 10 ** uint256(-normalization);
    }

    // ------------------------------------------------------------------ IDualOracle getters

    function BASE_TOKEN_0() external view override returns (address) {
        return ASSET;
    }

    function BASE_TOKEN_0_DECIMALS() external view override returns (uint256) {
        return ASSET_DECIMALS;
    }

    function BASE_TOKEN_1() external view override returns (address) {
        return ASSET;
    }

    function BASE_TOKEN_1_DECIMALS() external view override returns (uint256) {
        return ASSET_DECIMALS;
    }

    function QUOTE_TOKEN_0() external view override returns (address) {
        return COLLATERAL;
    }

    function QUOTE_TOKEN_0_DECIMALS() external view override returns (uint256) {
        return COLLATERAL_DECIMALS;
    }

    function QUOTE_TOKEN_1() external view override returns (address) {
        return COLLATERAL;
    }

    function QUOTE_TOKEN_1_DECIMALS() external view override returns (uint256) {
        return COLLATERAL_DECIMALS;
    }

    /// @notice collateralDecimals − assetDecimals.
    function NORMALIZATION_0() public view override returns (int256) {
        return int256(COLLATERAL_DECIMALS) - int256(ASSET_DECIMALS);
    }

    function NORMALIZATION_1() external view override returns (int256) {
        return NORMALIZATION_0();
    }

    function decimals() external pure override returns (uint8) {
        return DECIMALS;
    }

    function name() external view override returns (string memory) {
        return _name;
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IDualOracle).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
