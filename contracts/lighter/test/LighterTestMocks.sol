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

/// @notice Measures the gas a call consumes, so tests can prove a failed READ_CORE read burns
/// only the source's stipend and not the caller's remaining gas.
contract GasMeter {
    function measure(address target, bytes calldata data) external view returns (bool ok, uint256 gasUsed) {
        uint256 before = gasleft();
        (ok,) = target.staticcall(data);
        gasUsed = before - gasleft();
    }
}
