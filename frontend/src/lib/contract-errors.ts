// Contract error codes — mirrors sdk/src/errors.ts (the frontend keeps its own copy of the client).

/**
 * Mirrors `ContractError` in `contracts/ajo-circle/src/lib.rs`. The values are
 * load-bearing: Soroban reports failures as `Error(Contract, #<code>)`, and
 * this is the only way back from that number to the reason.
 */
export enum ContractErrorCode {
  CircleNotFound = 1,
  CircleFull = 2,
  AlreadyMember = 3,
  CircleNotForming = 4,
  CircleNotActive = 5,
  NotAMember = 6,
  AlreadyContributed = 7,
  CycleNotReady = 8,
  InvalidParams = 9,
  NotAuthorized = 10,
  Overflow = 11,
}

/** Human-readable explanation for each contract error code. */
export const CONTRACT_ERROR_MESSAGES: Record<ContractErrorCode, string> = {
  [ContractErrorCode.CircleNotFound]: "That circle doesn't exist.",
  [ContractErrorCode.CircleFull]: "This circle is already full.",
  [ContractErrorCode.AlreadyMember]: "You're already a member of this circle.",
  [ContractErrorCode.CircleNotForming]: "This circle is no longer accepting changes to its membership.",
  [ContractErrorCode.CircleNotActive]: "This circle isn't active.",
  [ContractErrorCode.NotAMember]: "You're not a member of this circle.",
  [ContractErrorCode.AlreadyContributed]: "You've already contributed this cycle.",
  [ContractErrorCode.CycleNotReady]: "This cycle isn't ready for payout yet.",
  [ContractErrorCode.InvalidParams]: "Invalid circle parameters.",
  [ContractErrorCode.NotAuthorized]: "You're not authorized to do that.",
  [ContractErrorCode.Overflow]: "The contract couldn't complete that — an amount overflowed its limit.",
};

const CONTRACT_ERROR_PATTERN = /Error\(Contract,\s*#(\d+)\)/;

/**
 * Extract the contract error code from a raw RPC/simulation error string,
 * or `null` if it isn't a (known) contract error.
 */
export function parseContractErrorCode(raw: string): ContractErrorCode | null {
  const match = CONTRACT_ERROR_PATTERN.exec(raw);
  if (!match) return null;
  const code = Number(match[1]);
  return code in CONTRACT_ERROR_MESSAGES ? (code as ContractErrorCode) : null;
}

/** Friendly message for a raw error string, falling back to the raw string. */
export function describeContractError(raw: string): string {
  const code = parseContractErrorCode(raw);
  return code === null ? raw : CONTRACT_ERROR_MESSAGES[code];
}
