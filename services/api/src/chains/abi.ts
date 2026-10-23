/** Minimal ABI shapes the platform needs from wUSDT / official USDT. */
export const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
  "function burn(uint256 amount)",
] as const;

/** LocalDexRouter — the devnet liquidity router in this repo. */
export const LOCAL_DEX_ABI = [
  "function quote(uint256 amountIn) view returns (uint256)",
  "function reserves() view returns (uint256 wusdtReserve, uint256 usdtReserve)",
  "function swapExactWusdtForUsdt(uint256 amountIn, uint256 minOut) returns (uint256)",
  "function FEE_BPS() view returns (uint256)",
] as const;

/** Uniswap V3 / PancakeSwap V3 style router, used on live EVM chains. */
export const UNISWAP_V3_ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) returns (uint256 amountOut)",
] as const;
