// SPDX-License-Identifier: MIT
// Copy of lumina-monorepo harness/src/MockReadCore.sol (lighter-devnet-v1 d23c099) with the pragma
// set to this repo's 0.8.20. Keep the two in sync. Etched at READ_CORE with hardhat_setCode.
pragma solidity 0.8.20;

contract MockReadCore {
    /// Lighter market type for spot markets. Lighter's READ_CORE returns 0 for both
    /// prices of a spot market, so the mock refuses to store anything else.
    uint8 private constant SPOT = 1;

    struct Market {
        bool exists;
        uint8 marketType;
        uint32 baseAssetId;
        uint32 quoteAssetId;
        uint32 takerFee;
        uint32 makerFee;
        uint64 minBaseAmount;
        uint64 minQuoteAmount;
        uint32 liquidationFee;
        uint64 indexPrice;
        uint64 markPrice;
    }

    struct TxStatus {
        bool exists;
        uint8 status;
        bytes data;
    }

    mapping(uint16 => Market) private _markets;
    mapping(uint64 => TxStatus) private _txStatuses;

    function setMarket(
        uint16 id,
        uint8 marketType,
        uint32 baseAssetId,
        uint32 quoteAssetId,
        uint32 takerFee,
        uint32 makerFee,
        uint64 minBaseAmount,
        uint64 minQuoteAmount,
        uint32 liquidationFee,
        uint64 indexPrice,
        uint64 markPrice
    ) external {
        require(marketType != SPOT || (indexPrice == 0 && markPrice == 0), "spot prices must be zero");
        _markets[id] = Market({
            exists: true,
            marketType: marketType,
            baseAssetId: baseAssetId,
            quoteAssetId: quoteAssetId,
            takerFee: takerFee,
            makerFee: makerFee,
            minBaseAmount: minBaseAmount,
            minQuoteAmount: minQuoteAmount,
            liquidationFee: liquidationFee,
            indexPrice: indexPrice,
            markPrice: markPrice
        });
    }

    function setPrices(uint16 id, uint64 indexPrice, uint64 markPrice) external {
        Market storage market = _markets[id];
        require(market.exists, "unknown market");
        require(market.marketType != SPOT, "spot market has no prices");
        market.indexPrice = indexPrice;
        market.markPrice = markPrice;
    }

    function removeMarket(uint16 id) external {
        delete _markets[id];
    }

    function setTxStatus(uint64 requestId, uint8 status, bytes calldata data) external {
        _txStatuses[requestId] = TxStatus({exists: true, status: status, data: data});
    }

    function getMarket(uint16 id) external view returns (Market memory) {
        return _markets[id];
    }

    function getTxStatus(uint64 requestId) external view returns (TxStatus memory) {
        return _txStatuses[requestId];
    }

    fallback(bytes calldata input) external returns (bytes memory) {
        if (input.length == 4 && uint16(bytes2(input[0:2])) == 0x0005) {
            uint16 id = uint16(bytes2(input[2:4]));
            Market storage market = _markets[id];
            if (market.exists) {
                return abi.encode(
                    market.marketType,
                    market.baseAssetId,
                    market.quoteAssetId,
                    market.takerFee,
                    market.makerFee,
                    market.minBaseAmount,
                    market.minQuoteAmount,
                    market.liquidationFee,
                    market.indexPrice,
                    market.markPrice
                );
            }
        } else if (input.length == 10 && uint16(bytes2(input[0:2])) == 0x0000) {
            uint64 requestId = uint64(bytes8(input[2:10]));
            TxStatus storage txStatus = _txStatuses[requestId];
            if (txStatus.exists) {
                return abi.encode(txStatus.status, txStatus.data);
            }
        }

        assembly {
            invalid()
        }
    }
}
