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
  // wUSDT-only reads: who mints it (the TreasuryVault) and who governs it.
  "function minter() view returns (address)",
  "function governor() view returns (address)",
  "function paused() view returns (bool)",
  "function pause()",
  "function unpause()",
  // Redemption: burn + a replay-safe request id the vault's operator confirms.
  "function requestRedemption(uint256 amount) returns (bytes32)",
  "function redemptionNonce() view returns (uint256)",
] as const;

/**
 * TreasuryVault — the shadow reserve: replay-protected injections, the 25 %
 * distribution cycle, reserve releases and redemption confirmation.
 */
export const TREASURY_VAULT_ABI = [
  "function wUSDT() view returns (address)",
  "function decimals() view returns (uint8)",
  "function governor() view returns (address)",
  "function currentReserve() view returns (uint256)",
  "function redemptionReleased() view returns (uint256)",
  "function maxReserve() view returns (uint256)",
  "function paused() view returns (bool)",
  "function ADMIN_ROLE() view returns (bytes32)",
  "function BRIDGE_ROLE() view returns (bytes32)",
  "function OPERATOR_ROLE() view returns (bytes32)",
  "function PAUSER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function processedMessages(bytes32 messageId) view returns (bool)",
  "function releasedRedemptions(bytes32 requestId) view returns (bool)",
  "function getCurrentReserve() view returns (uint256)",
  "function getUtilizationBps() view returns (uint256)",
  "function expectedVaultBalance() view returns (uint256)",
  "function reserveDrift() view returns (int256)",
  "function injectNetReserve(bytes32 messageId, uint256 amount)",
  "function distributeToAppWallets(address[] wallets)",
  "function releaseReserve(address to, uint256 amount)",
  "function confirmRedemption(bytes32 requestId, address user, uint256 amount)",
  "function grantRole(bytes32 role, address account)",
  "function revokeRole(bytes32 role, address account)",
  "function setMaxReserve(uint256 newMaxReserve)",
  "function setGovernor(address newGovernor)",
  "function pause()",
  "function unpause()",
  // Declared so a revert decodes into a named error instead of "unknown custom error".
  "error AlreadyProcessed(bytes32 id)",
  "error CapacityExceeded(uint256 requested, uint256 available)",
  "error InsufficientReserve(uint256 requested, uint256 available)",
  "error EmptyBatch()",
  "error BatchTooLarge(uint256 size)",
  "error ZeroAmount()",
  "error ZeroAddress()",
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
