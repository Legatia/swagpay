import type { NewTransfer } from "./payments";

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** Arc emits an ERC-20-style Transfer (18 decimals) from this address for every native USDC movement (EIP-7708). */
export const USDC_SYSTEM_EMITTER = "0xfffffffffffffffffffffffffffffffffffffffe";

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}

export interface LogFilter {
  fromBlock: number;
  toBlock: number;
  address: string[];
  topics: (string | null)[];
}

export interface RpcClient {
  chainId(): Promise<number>;
  blockNumber(): Promise<number>;
  getLogs(filter: LogFilter): Promise<RawLog[]>;
}

const isStr = (v: unknown) => typeof v === "string";
function isLogArray(r: unknown): boolean {
  return Array.isArray(r) && r.every((l) => l && typeof l === "object" && ["address", "data", "blockNumber", "transactionHash", "logIndex"].every((k) => isStr((l as Record<string, unknown>)[k])) && Array.isArray(l.topics) && l.topics.every(isStr));
}

const hex = (n: number) => `0x${n.toString(16)}`;

/**
 * JSON-RPC over fetch. Until a URL answers, each call tries the URLs in order and throws the last error; after that,
 * every call uses the URL that answered and throws when it fails, so one client (one watcher run) reads one node.
 */
export function createRpc(urls: string[], fetchImpl: typeof fetch = fetch): RpcClient {
  let id = 0;
  let pinned: string | null = null;
  const call = async (method: string, params: unknown[], check: (result: unknown) => boolean): Promise<unknown> => {
    let last: Error = new Error("no RPC URL configured");
    for (const url of pinned === null ? urls : [pinned]) {
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
        const body = (await res.json()) as { result?: unknown; error?: { code?: number; message?: string } };
        if (body.error) throw new Error(`${method}: ${body.error.code} ${body.error.message}`);
        if (!check(body.result)) throw new Error(`${method}: unexpected result`);
        pinned = url;
        return body.result;
      } catch (err) {
        last = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw last;
  };
  const quantity = (r: unknown) => typeof r === "string" && /^0x[0-9a-fA-F]+$/.test(r);
  return {
    async chainId() {
      return Number(BigInt(String(await call("eth_chainId", [], quantity))));
    },
    async blockNumber() {
      return Number(BigInt(String(await call("eth_blockNumber", [], quantity))));
    },
    async getLogs(f) {
      const result = await call("eth_getLogs", [{ fromBlock: hex(f.fromBlock), toBlock: hex(f.toBlock), address: f.address, topics: f.topics }], isLogArray);
      return result as RawLog[];
    },
  };
}

export function addressTopic(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

/**
 * A Transfer log to our address as a NewTransfer, or null when it isn't USDC (system emitter) or EURC.
 * With `recipient` or `range`, also null for a log to another address or from a block outside the range.
 */
export function decodeTransfer(log: RawLog, eurcAddress: string, recipient?: string, range?: { from: number; to: number }): NewTransfer | null {
  if (log.topics.length !== 3 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) return null;
  if (recipient !== undefined && log.topics[2]?.toLowerCase() !== addressTopic(recipient)) return null;
  const blockNumber = Number(BigInt(log.blockNumber));
  if (range && (blockNumber < range.from || blockNumber > range.to)) return null;
  const emitter = log.address.toLowerCase();
  let units: bigint;
  let token: NewTransfer["token"];
  const value = BigInt(log.data);
  if (emitter === USDC_SYSTEM_EMITTER) {
    token = "USDC";
    units = value / 10n ** 12n;
  } else if (emitter === eurcAddress.toLowerCase()) {
    token = "EURC";
    units = value;
  } else {
    return null;
  }
  if (units <= 0n || units > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return {
    txHash: log.transactionHash.toLowerCase(),
    logIndex: Number(BigInt(log.logIndex)),
    blockNumber,
    token,
    from: `0x${log.topics[1].slice(-40)}`.toLowerCase(),
    amountUnits: Number(units),
  };
}
