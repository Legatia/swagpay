import { createWalletClient, defineChain, erc20Abi, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TESTNET_CHAIN_ID } from "./config";

/** Arc testnet's USDC (6-decimal ERC-20 view of the gas token). */
const USDC = "0x3600000000000000000000000000000000000000";

export interface ChainClient { address(): string; transferUsdc(to: string, units: number): Promise<string /* tx hash */> }

/** A viem wallet on Arc testnet from SANDBOX_WALLET_KEY; throws unless ARC_CHAIN_ID is the testnet's and the key is a 0x-prefixed 32-byte hex. */
export function createChainClient(env: Env): ChainClient {
  if (String(env.ARC_CHAIN_ID) !== TESTNET_CHAIN_ID) throw new Error(`sandbox chain client needs ARC_CHAIN_ID ${TESTNET_CHAIN_ID}, got ${env.ARC_CHAIN_ID}`);
  const key = env.SANDBOX_WALLET_KEY;
  if (!key) throw new Error("SANDBOX_WALLET_KEY is not set");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("SANDBOX_WALLET_KEY must be a 0x-prefixed 32-byte hex key");
  const account = privateKeyToAccount(key as `0x${string}`);
  const chain = defineChain({
    id: Number(TESTNET_CHAIN_ID), name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [env.ARC_RPC_URL] } },
  });
  const wallet = createWalletClient({ account, chain, transport: http(env.ARC_RPC_URL) });
  return {
    address: () => account.address,
    transferUsdc: (to, units) => wallet.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [to as `0x${string}`, BigInt(units)] }),
  };
}
