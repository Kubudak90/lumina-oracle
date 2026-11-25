// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/// @notice Test-only stand-in for READ_CORE that answers market-info reads with a response of a
/// configurable length (to test the 320-byte check). Etched at READ_CORE with hardhat_setCode.
contract MockReadCoreBadLength {
    uint256 private _length;

    function configureResponseLength(uint256 length) external {
        _length = length;
    }

    fallback(bytes calldata) external returns (bytes memory ret) {
        ret = new bytes(_length); // all-zero words decode to marketType 0 (perp), price 0
        if (_length >= 320) {
            // put a plausible non-zero index price in word 8 so only the length check can fail
            assembly {
                mstore(add(ret, add(32, 256)), 300000)
            }
        }
    }
}

/// @notice Failure modes shared by the test mocks below.
library MockMode {
    uint8 internal constant NORMAL = 0;
    uint8 internal constant REVERT = 1;
    uint8 internal constant EMPTY_RETURN = 2; // succeeds with no returndata
    uint8 internal constant BAD_WORD = 3; // succeeds with a word outside the declared type
    uint8 internal constant BURN_GAS = 4; // consumes all forwarded gas
    uint8 internal constant LONG_RETURN = 5; // succeeds with 64 bytes
    uint8 internal constant HUGE_RETURN = 6; // succeeds with 64 KiB
    uint8 internal constant MAX_RETURN = 7; // spends ~90% of its gas on the largest possible return

    function act(uint8 mode, uint256 badWord) internal view {
        if (mode == REVERT) revert("mock revert");
        if (mode == BURN_GAS) {
            while (gasleft() > 0) {}
        }
        if (mode == EMPTY_RETURN) {
            assembly {
                return(0, 0)
            }
        }
        if (mode == BAD_WORD) {
            assembly {
                mstore(0, badWord)
                return(0, 32)
            }
        }
        if (mode == LONG_RETURN) {
            assembly {
                mstore(0, 1)
                mstore(32, 1)
                return(0, 64)
            }
        }
        if (mode == HUGE_RETURN) {
            assembly {
                mstore(0, 1)
                return(0, 65536)
            }
        }
        if (mode == MAX_RETURN) {
            // memory cost of w words ≈ 3w + w²/512; pick w with w²/512 ≈ 90% of the gas left
            uint256 target = (gasleft() * 9) / 10;
            uint256 w = _sqrt(512 * target);
            uint256 size = w * 32;
            assembly {
                return(0, size)
            }
        }
    }

    function _sqrt(uint256 x) private pure returns (uint256 y) {
        if (x == 0) return 0;
        y = x;
        uint256 z = (x + 1) / 2;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}

/// @notice Test-only 8-decimal price source with a settable answer or a failure mode.
contract MockLighterPriceSource {
    int256 public answer;
    bool public shouldRevert;
    uint8 public mode;
    uint16 public MARKET_ID;

    constructor(uint16 marketId, int256 initialAnswer) {
        MARKET_ID = marketId;
        answer = initialAnswer;
    }

    function setAnswer(int256 newAnswer) external {
        answer = newAnswer;
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function setMode(uint8 value) external {
        mode = value;
    }

    function latestAnswer() external view returns (int256) {
        require(!shouldRevert, "mock source revert");
        MockMode.act(mode, type(uint256).max);
        return answer;
    }
}

/// @notice Test-only borrow guard with a settable answer or a failure mode.
contract MockBorrowGuard {
    bool public allowed = true;
    bool public shouldRevert;
    uint8 public mode;

    function setAllowed(bool value) external {
        allowed = value;
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function setMode(uint8 value) external {
        mode = value;
    }

    function isBorrowAllowed() external view returns (bool) {
        require(!shouldRevert, "mock guard revert");
        MockMode.act(mode, 2); // BAD_WORD: 2 is not a valid bool
        return allowed;
    }
}

/// @notice Test-only token exposing just `decimals()`.
contract MockDecimalsToken {
    uint8 public immutable decimals;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }
}

/// @notice Liquidation-like consumer: reads the dual oracle, then needs `workGas` more gas to
/// finish (standing in for the rest of a liquidation).
contract PriceConsumer {
    function consume(address oracle, uint256 workGas) external view returns (uint256 rate) {
        (, rate,) = IDualOracleLike(oracle).getPrices();
        uint256 start = gasleft();
        while (start - gasleft() < workGas) {}
    }
}

interface IDualOracleLike {
    function getPrices() external view returns (bool, uint256, uint256);
}

/// @notice Measures the gas a call consumes, so tests can prove a failed READ_CORE read burns
/// only the source's stipend and not the caller's remaining gas.
contract GasMeter {
    function measure(address target, bytes calldata data) external view returns (bool ok, uint256 gasUsed) {
        uint256 before = gasleft();
        (ok,) = target.staticcall(data);
        gasUsed = before - gasleft();
    }
}

/// @notice Pair-like consumer of the dual oracle, mirroring `LightlendPairCore._updateExchangeRate`:
/// `getPrices()` is called at most once per block (cache keyed on `block.timestamp`) and the returned
/// flag is stored, so it holds for every later call in that block. `liquidateLike` spends
/// `gasBefore`, refreshes the cache like `liquidate()`, then spends `gasAfter` (the rest of a
/// liquidation; the pair accrues interest before the rate update and does the transfers after).
contract PairLikeOracleCaller {
    struct Cache {
        uint64 lastTimestamp;
        bool oneOracleBad;
        uint184 rate;
    }

    address public immutable ORACLE;
    Cache public cache;

    event UpdateExchangeRate(bool oneOracleBad, uint256 rate);

    constructor(address oracle) {
        ORACLE = oracle;
    }

    function updateExchangeRate() external returns (bool isBorrowAllowed, uint256 rate) {
        return _update();
    }

    function liquidateLike(uint256 gasBefore, uint256 gasAfter) external returns (uint256 rate) {
        uint256 start = gasleft();
        while (start - gasleft() < gasBefore) {}
        (, rate) = _update();
        start = gasleft();
        while (start - gasleft() < gasAfter) {}
    }

    function _update() internal returns (bool isBorrowAllowed, uint256 rate) {
        Cache memory c = cache;
        if (c.lastTimestamp != block.timestamp) {
            (bool bad, uint256 low,) = IDualOracleLike(ORACLE).getPrices();
            c = Cache(uint64(block.timestamp), bad, uint184(low));
            cache = c;
            emit UpdateExchangeRate(bad, low);
        }
        return (!c.oneOracleBad, c.rate);
    }
}

/// @notice Calls the dual oracle's `getPrices()` with exactly `gasLimit` gas (the caller must have
/// 64/63 of it) and reports success, the return or revert data, and the gas the call consumed.
contract OracleGasProbe {
    function probe(address oracle, uint256 gasLimit)
        external
        view
        returns (bool ok, bytes memory ret, uint256 gasUsed)
    {
        bytes memory data = abi.encodeWithSelector(IDualOracleLike.getPrices.selector);
        uint256 before = gasleft();
        (ok, ret) = oracle.staticcall{gas: gasLimit}(data);
        gasUsed = before - gasleft();
    }
}

/// @notice Test-only READ_CORE stand-in that charges ~20k gas per market-info read (the cost the
/// Lighter docs give for the real precompile; `MockReadCore` costs a few thousand) and, like the real
/// precompile, burns all forwarded gas on a failed read. Answers perp market 0 only, with a settable
/// index price. Etched at READ_CORE with hardhat_setCode.
contract MockReadCoreCostly {
    uint256 internal constant READ_GAS = 20_000;
    uint64 public indexPrice;

    function setIndexPrice(uint64 price) external {
        indexPrice = price;
    }

    fallback(bytes calldata input) external returns (bytes memory) {
        uint256 start = gasleft();
        if (input.length == 4 && uint16(bytes2(input[0:2])) == 0x0005 && uint16(bytes2(input[2:4])) == 0) {
            bytes memory out = abi.encode(
                uint8(0), uint32(1), uint32(5), uint32(20), uint32(5), uint64(1e6), uint64(1e6), uint32(50),
                indexPrice, indexPrice
            );
            // burn until ~READ_GAS has been used in this frame; running out of gas fails the read
            while (start - gasleft() < READ_GAS) {}
            return out;
        }
        assembly {
            invalid()
        }
    }
}
