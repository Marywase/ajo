// Contract.
import {
  Account,
  Address,
  Contract,
  FeeBumpTransaction,
  Keypair,
  Transaction,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { ContractErrorCode, describeContractError, parseContractErrorCode } from "./contract-errors";
import { CONTRACT_ID, NETWORK_PASSPHRASE } from "./network-config";

const RPC_URL = process.env.NEXT_PUBLIC_STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
export const NATIVE_TOKEN_ID = process.env.NEXT_PUBLIC_NATIVE_TOKEN_ID ?? "";

export const server = new rpc.Server(RPC_URL);
function getContract() {
  return new Contract(CONTRACT_ID);
}

export enum CircleStatus {
  Forming = 0,
  Active = 1,
  Completed = 2,
  Cancelled = 3,
}

export interface Circle {
  id: bigint;
  creator: string;
  token: string;
  contributionAmount: bigint;
  maxMembers: number;
  cycleLengthSecs: bigint;
  members: string[];
  startedAt: bigint;
  currentCycle: number;
  status: CircleStatus;
}

// Raw shape returned by scValToNative for the Rust `Circle` struct —
// soroban-sdk maps struct field names verbatim (snake_case) into the
// decoded object's keys.
interface RawCircle {
  id: bigint;
  creator: string;
  token: string;
  contribution_amount: bigint;
  max_members: number;
  cycle_length_secs: bigint;
  members: string[];
  started_at: bigint;
  current_cycle: number;
  status: number;
}

function parseCircle(raw: RawCircle): Circle {
  return {
    id: raw.id,
    creator: raw.creator,
    token: raw.token,
    contributionAmount: raw.contribution_amount,
    maxMembers: raw.max_members,
    cycleLengthSecs: raw.cycle_length_secs,
    members: raw.members,
    startedAt: raw.started_at,
    currentCycle: raw.current_cycle,
    status: raw.status as CircleStatus,
  };
}

export class ContractCallError extends Error {
  /** The contract's `ContractError` code, when the failure was one. */
  readonly code: ContractErrorCode | null;

  constructor(message: string, code: ContractErrorCode | null = null) {
    super(message);
    this.code = code;
  }

  /** Build from a raw simulation error, resolving known contract error codes. */
  static fromSimulationError(raw: string): ContractCallError {
    return new ContractCallError(describeContractError(raw), parseContractErrorCode(raw));
  }
}

const SEND_TX_MAX_ATTEMPTS = 5;
const SEND_TX_RETRY_BASE_DELAY_MS = 500;

/**
 * Calls `server.sendTransaction`, retrying with exponential backoff on
 * `TRY_AGAIN_LATER` — the node's mempool was busy and the transaction was
 * never actually broadcast, so falling straight into the `getTransaction`
 * poll loop would never find it and would only time out after the full
 * ~60s window (#150). `DUPLICATE` and `PENDING` are returned as-is: a
 * duplicate submission is treated as success by the caller, which proceeds
 * to poll for the (already-submitted) transaction as normal.
 */
export async function sendWithRetry(
  server: rpc.Server,
  tx: Transaction | FeeBumpTransaction,
): Promise<rpc.Api.SendTransactionResponse> {
  let sent = await server.sendTransaction(tx);
  for (
    let attempt = 0;
    sent.status === "TRY_AGAIN_LATER" && attempt < SEND_TX_MAX_ATTEMPTS;
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, SEND_TX_RETRY_BASE_DELAY_MS * 2 ** attempt));
    sent = await server.sendTransaction(tx);
  }
  return sent;
}

/** Read-only call, simulated against a throwaway account — no wallet or funds required. */
async function readCall<T>(method: string, args: xdr.ScVal[]): Promise<T> {
  const account = new Account(Keypair.random().publicKey(), "0");
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(getContract().call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw ContractCallError.fromSimulationError(sim.error);
  }
  return scValToNative(sim.result!.retval) as T;
}

export async function getCircle(circleId: bigint): Promise<Circle> {
  const raw = await readCall<RawCircle>("get_circle", [nativeToScVal(circleId, { type: "u64" })]);
  return parseCircle(raw);
}

export async function hasContributed(circleId: bigint, cycle: number, member: string): Promise<boolean> {
  return readCall<boolean>("has_contributed", [
    nativeToScVal(circleId, { type: "u64" }),
    nativeToScVal(cycle, { type: "u32" }),
    new Address(member).toScVal(),
  ]);
}

export async function missedCount(circleId: bigint, member: string): Promise<number> {
  return readCall<number>("missed_count", [
    nativeToScVal(circleId, { type: "u64" }),
    new Address(member).toScVal(),
  ]);
}

export async function getTotalCircles(): Promise<bigint> {
  return readCall<bigint>("total_circles", []);
}

/** Build an unsigned, simulated-and-assembled transaction ready for a wallet to sign. */
async function buildTx(sourcePublicKey: string, method: string, args: xdr.ScVal[]) {
  const account = await server.getAccount(sourcePublicKey);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(getContract().call(method, ...args))
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw ContractCallError.fromSimulationError(sim.error);
  }
  return rpc.assembleTransaction(tx, sim).build().toXDR();
}

export function buildCreateCircleTx(
  creator: string,
  token: string,
  contributionAmount: bigint,
  maxMembers: number,
  cycleLengthSecs: bigint,
) {
  return buildTx(creator, "create_circle", [
    new Address(creator).toScVal(),
    new Address(token).toScVal(),
    nativeToScVal(contributionAmount, { type: "i128" }),
    nativeToScVal(maxMembers, { type: "u32" }),
    nativeToScVal(cycleLengthSecs, { type: "u64" }),
  ]);
}

export function buildJoinCircleTx(circleId: bigint, member: string) {
  return buildTx(member, "join_circle", [
    nativeToScVal(circleId, { type: "u64" }),
    new Address(member).toScVal(),
  ]);
}

export function buildContributeTx(circleId: bigint, member: string) {
  return buildTx(member, "contribute", [
    nativeToScVal(circleId, { type: "u64" }),
    new Address(member).toScVal(),
  ]);
}

export function buildDisburseTx(circleId: bigint, caller: string) {
  return buildTx(caller, "disburse", [nativeToScVal(circleId, { type: "u64" })]);
}

export function buildLeaveCircleTx(circleId: bigint, member: string) {
  return buildTx(member, "leave_circle", [
    nativeToScVal(circleId, { type: "u64" }),
    new Address(member).toScVal(),
  ]);
}

export function buildCancelCircleTx(circleId: bigint, caller: string) {
  return buildTx(caller, "cancel_circle", [
    nativeToScVal(circleId, { type: "u64" }),
    new Address(caller).toScVal(),
  ]);
}

/**
 * Submit a wallet-signed transaction XDR and poll until it lands. Resolves
 * with the call's decoded return value (mirrors the SDK), or `undefined`
 * for void calls.
 */
export async function submitSignedTx<T = unknown>(signedXdr: string): Promise<T | undefined> {
  const tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  const sent = await sendWithRetry(server, tx);
  if (sent.status === "ERROR") {
    throw new ContractCallError(`Transaction rejected: ${JSON.stringify(sent.errorResult)}`);
  }

  const maxAttempts = 40; // ~60s at 1.5s/poll — a dropped tx should never hang the UI forever
  let result: rpc.Api.GetTransactionResponse | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      result = await server.getTransaction(sent.hash);
      if (result.status !== "NOT_FOUND") {
        break;
      }
    } catch (err) {
      if (attempt === maxAttempts - 1) {
        throw err;
      }
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  if (!result || result.status === "NOT_FOUND") {
    throw new ContractCallError(`Transaction ${sent.hash} was not found on-chain after ${maxAttempts} polls — it may have been dropped.`);
  }
  if (result.status !== "SUCCESS") {
    throw new ContractCallError(`Transaction failed: ${JSON.stringify(result)}`);
  }
  const rv = result.returnValue;
  if (rv === undefined || rv.switch() === xdr.ScValType.scvVoid()) return undefined;
  return scValToNative(rv) as T;
}

/**
 * Discover circle ids by reading `circle created` events — no backend or
 * indexer required.
 *
 * The default lookback (9,000 ledgers, ~12.5h) is deliberately far short of
 * the RPC node's much larger nominal retention window (~120,960 ledgers,
 * ~7 days). Empirically, a public Soroban RPC node accepts a `startLedger`
 * anywhere inside that whole retention window without erroring, but
 * silently returns zero events — not an error, just an empty result — once
 * the requested span exceeds a much smaller *searchable* window (observed
 * between 10,000 and 12,000 ledgers). Retention and searchability turned
 * out not to be the same guarantee; only the latter matters here. Circles
 * older than this lookback still resolve fine by id — getCircle reads
 * contract storage directly, not events — see lib/circle-cache.ts for how
 * this page still finds them.
 */
export async function discoverCircleIds(lookbackLedgers = 9_000, limit = 50): Promise<bigint[]> {
  const latest = await server.getLatestLedger();
  const startLedger = Math.max(latest.sequence - lookbackLedgers, 1);

  const fetchEvents = (from: number) =>
    server.getEvents({
      startLedger: from,
      filters: [
        {
          type: "contract",
          contractIds: [CONTRACT_ID],
          topics: [[xdr.ScVal.scvSymbol("circle").toXDR("base64"), xdr.ScVal.scvSymbol("created").toXDR("base64")]],
        },
      ],
      limit,
    });

  let res;
  try {
    res = await fetchEvents(startLedger);
  } catch (err) {
    const min = minLedgerFromRangeError(err);
    if (min === null) throw err;
    res = await fetchEvents(min);
  }

  return res.events.map((e) => scValToNative(e.value) as bigint).reverse();
}

/** Extracts the lower bound from a Soroban RPC "startLedger must be within the ledger range: X - Y" error. */
function minLedgerFromRangeError(err: unknown): number | null {
  const message =
    typeof err === "object" && err !== null && "message" in err
      ? String((err as { message: unknown }).message)
      : String(err);
  const match = /ledger range:\s*(\d+)/.exec(message);
  return match ? Number(match[1]) : null;
}