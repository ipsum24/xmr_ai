// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Like {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title LocalDexRouter — devnet stand-in for the per-chain DEX router
 *
 * In live mode the orchestrator routes swaps through the chain's real DEX
 * (Uniswap SwapRouter02 on Ethereum/Arbitrum/Polygon, PancakeSwap Smart Router
 * on BSC, SunSwap on TRON). A local devnet chain has no DEX deployment, so this
 * router provides the same shape: exact-amount approvals, a real pull of wUSDT
 * into the pool, a 0.05 % fee tier, and real USDT out at the peg.
 *
 * Liquidity is seeded at bootstrap with real USDT transfers into this contract,
 * so `swapExactWusdtForUsdt` can only pay out what the pool actually holds.
 */
contract LocalDexRouter {
    address public immutable wusdt;
    address public immutable usdt;

    /// 0.05 % — the fee tier the peg pool runs at.
    uint256 public constant FEE_BPS = 5;
    uint256 public constant BPS_DENOMINATOR = 10_000;

    event Swap(address indexed sender, uint256 amountIn, uint256 amountOut, uint256 fee);

    constructor(address wusdt_, address usdt_) {
        require(wusdt_ != address(0) && usdt_ != address(0), "zero token");
        wusdt = wusdt_;
        usdt = usdt_;
    }

    /// @notice Spot quote for an exact wUSDT input, fee included.
    function quote(uint256 amountIn) public pure returns (uint256 amountOut) {
        amountOut = (amountIn * (BPS_DENOMINATOR - FEE_BPS)) / BPS_DENOMINATOR;
    }

    function reserves() external view returns (uint256 wusdtReserve, uint256 usdtReserve) {
        wusdtReserve = IERC20Like(wusdt).balanceOf(address(this));
        usdtReserve = IERC20Like(usdt).balanceOf(address(this));
    }

    /// @notice Swap wUSDT for USDT. Caller must approve this router for `amountIn` first.
    function swapExactWusdtForUsdt(uint256 amountIn, uint256 minOut)
        external
        returns (uint256 amountOut)
    {
        require(amountIn > 0, "zero input");
        require(IERC20Like(wusdt).transferFrom(msg.sender, address(this), amountIn), "pull failed");

        amountOut = quote(amountIn);
        require(amountOut >= minOut, "insufficient output amount");
        require(IERC20Like(usdt).balanceOf(address(this)) >= amountOut, "insufficient liquidity");
        require(IERC20Like(usdt).transfer(msg.sender, amountOut), "usdt transfer failed");

        emit Swap(msg.sender, amountIn, amountOut, amountIn - amountOut);
    }
}
