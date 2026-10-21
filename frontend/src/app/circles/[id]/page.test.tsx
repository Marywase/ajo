// Circle detail page tests.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import CircleDetailPage from "./page";
import {
  buildContributeTx,
  buildJoinCircleTx,
  CircleStatus,
  getCircle,
  hasContributed,
  missedCount,
  NATIVE_TOKEN_ID,
  submitSignedTx,
  type Circle,
} from "@/lib/contract";
import { invalidateCircleCache } from "@/lib/rpc-cache";
import { useWallet } from "@/context/wallet-context";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "7" }),
  usePathname: () => "/circles/7",
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/components/navbar", () => ({ Navbar: () => null }));
vi.mock("@/components/footer", () => ({ Footer: () => null }));

vi.mock("@/context/wallet-context", () => ({ useWallet: vi.fn() }));

// Delegating to the mocked contract reads keeps the page's caching wrapper
// transparent while still letting each test control the underlying values.
vi.mock("@/lib/rpc-cache", () => ({
  hasContributedCached: vi.fn(
    (
      fn: (circleId: bigint, cycle: number, member: string) => Promise<boolean>,
      circleId: bigint,
      cycle: number,
      member: string,
    ) => fn(circleId, cycle, member),
  ),
  missedCountCached: vi.fn(
    (fn: (circleId: bigint, member: string) => Promise<number>, circleId: bigint, member: string) =>
      fn(circleId, member),
  ),
  invalidateCircleCache: vi.fn(),
}));

vi.mock("@/lib/contract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/contract")>();
  return {
    ...actual,
    getCircle: vi.fn(),
    hasContributed: vi.fn(),
    missedCount: vi.fn(),
    buildJoinCircleTx: vi.fn(),
    buildContributeTx: vi.fn(),
    buildDisburseTx: vi.fn(),
    buildLeaveCircleTx: vi.fn(),
    buildCancelCircleTx: vi.fn(),
    submitSignedTx: vi.fn(),
  };
});

const ALICE = "GALICE";
const BOB = "GBOB";
const CAROL = "GCAROL";
const STRANGER = "GSTRANGER";

const JOIN = "Join this circle";
const LEAVE = "Leave circle";
const CANCEL = "Cancel circle";
const DISBURSE = "Trigger payout";
const CONTRIBUTE = "Contribute 50 XLM";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockUseWallet = vi.mocked(useWallet);

/** Point the wallet context at `address`, with a signing stub that succeeds. */
function setWallet(address: string | null) {
  mockUseWallet.mockReturnValue({
    address,
    connecting: false,
    restoring: false,
    connectWallet: vi.fn().mockResolvedValue(address ?? ALICE),
    disconnectWallet: vi.fn(),
    signTransaction: vi.fn().mockResolvedValue("SIGNED"),
  });
}

function makeCircle(overrides: Partial<Circle> = {}): Circle {
  return {
    id: 7n,
    creator: ALICE,
    token: NATIVE_TOKEN_ID,
    contributionAmount: 50_0000000n,
    maxMembers: 3,
    cycleLengthSecs: 86_400n,
    members: [ALICE, BOB, CAROL],
    startedAt: 0n,
    currentCycle: 0,
    status: CircleStatus.Forming,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCircle).mockResolvedValue(makeCircle());
  vi.mocked(hasContributed).mockResolvedValue(false);
  vi.mocked(missedCount).mockResolvedValue(0);
  vi.mocked(buildJoinCircleTx).mockResolvedValue("UNSIGNED");
  vi.mocked(buildContributeTx).mockResolvedValue("UNSIGNED");
  vi.mocked(submitSignedTx).mockResolvedValue(undefined);
  setWallet(null);

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function renderPage() {
  await act(async () => {
    root.render(createElement(CircleDetailPage));
  });
  await flush();
}

/** Button whose trimmed label matches exactly — CopyButton labels differ, so this stays precise. */
function buttonByText(text: string): HTMLButtonElement | null {
  const match = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  );
  return (match as HTMLButtonElement | undefined) ?? null;
}

describe("CircleDetailPage — action buttons per status and role", () => {
  it("Forming · non-member only offers Join", async () => {
    setWallet(STRANGER);
    await renderPage();

    expect(buttonByText(JOIN)).not.toBeNull();
    expect(buttonByText(LEAVE)).toBeNull();
    expect(buttonByText(CANCEL)).toBeNull();
    expect(buttonByText(CONTRIBUTE)).toBeNull();
    expect(buttonByText(DISBURSE)).toBeNull();
  });

  it("Forming · member (non-creator) only offers Leave", async () => {
    setWallet(BOB);
    await renderPage();

    expect(buttonByText(LEAVE)).not.toBeNull();
    expect(buttonByText(JOIN)).toBeNull();
    expect(buttonByText(CANCEL)).toBeNull();
    expect(buttonByText(CONTRIBUTE)).toBeNull();
    expect(buttonByText(DISBURSE)).toBeNull();
  });

  it("Forming · creator who is still a member may Leave and Cancel", async () => {
    setWallet(ALICE);
    await renderPage();

    expect(buttonByText(LEAVE)).not.toBeNull();
    expect(buttonByText(CANCEL)).not.toBeNull();
    expect(buttonByText(JOIN)).toBeNull();
  });

  it("Forming · creator who has left cannot Cancel", async () => {
    vi.mocked(getCircle).mockResolvedValue(makeCircle({ creator: ALICE, members: [BOB, CAROL] }));
    setWallet(ALICE);
    await renderPage();

    expect(buttonByText(JOIN)).not.toBeNull();
    expect(buttonByText(CANCEL)).toBeNull();
  });

  it("Active · member who hasn't paid this cycle sees Contribute and Trigger payout", async () => {
    vi.mocked(getCircle).mockResolvedValue(makeCircle({ status: CircleStatus.Active }));
    setWallet(ALICE);
    await renderPage();

    expect(buttonByText(CONTRIBUTE)).not.toBeNull();
    expect(buttonByText(DISBURSE)).not.toBeNull();
    expect(buttonByText(JOIN)).toBeNull();
    expect(buttonByText(LEAVE)).toBeNull();
    expect(buttonByText(CANCEL)).toBeNull();
  });

  it("Active · member who already paid keeps Trigger payout but loses Contribute", async () => {
    vi.mocked(getCircle).mockResolvedValue(makeCircle({ status: CircleStatus.Active }));
    vi.mocked(hasContributed).mockImplementation(async (_id, _cycle, member) => member === ALICE);
    setWallet(ALICE);
    await renderPage();

    expect(buttonByText(CONTRIBUTE)).toBeNull();
    expect(buttonByText(DISBURSE)).not.toBeNull();
  });

  it("Active · non-member can still Trigger payout but cannot Contribute", async () => {
    vi.mocked(getCircle).mockResolvedValue(makeCircle({ status: CircleStatus.Active }));
    setWallet(STRANGER);
    await renderPage();

    expect(buttonByText(CONTRIBUTE)).toBeNull();
    expect(buttonByText(DISBURSE)).not.toBeNull();
  });

  it("Completed · offers no actions", async () => {
    vi.mocked(getCircle).mockResolvedValue(makeCircle({ status: CircleStatus.Completed }));
    setWallet(ALICE);
    await renderPage();

    expect(buttonByText(JOIN)).toBeNull();
    expect(buttonByText(LEAVE)).toBeNull();
    expect(buttonByText(CANCEL)).toBeNull();
    expect(buttonByText(CONTRIBUTE)).toBeNull();
    expect(buttonByText(DISBURSE)).toBeNull();
  });

  it("Cancelled · offers no actions", async () => {
    vi.mocked(getCircle).mockResolvedValue(makeCircle({ status: CircleStatus.Cancelled }));
    setWallet(ALICE);
    await renderPage();

    expect(buttonByText(JOIN)).toBeNull();
    expect(buttonByText(LEAVE)).toBeNull();
    expect(buttonByText(CANCEL)).toBeNull();
    expect(buttonByText(CONTRIBUTE)).toBeNull();
    expect(buttonByText(DISBURSE)).toBeNull();
  });
});

describe("CircleDetailPage — refresh after a successful action", () => {
  it("reloads the circle, clears the RPC cache and updates the buttons after Join", async () => {
    vi.mocked(getCircle)
      .mockResolvedValueOnce(makeCircle({ creator: BOB, members: [BOB, CAROL] }))
      .mockResolvedValueOnce(makeCircle({ creator: BOB, members: [ALICE, BOB, CAROL] }));
    setWallet(ALICE);
    await renderPage();
    expect(buttonByText(JOIN)).not.toBeNull();

    await act(async () => {
      buttonByText(JOIN)!.click();
    });

    expect(buildJoinCircleTx).toHaveBeenCalledWith(7n, ALICE);
    expect(submitSignedTx).toHaveBeenCalledWith("SIGNED");
    expect(toast.success).toHaveBeenCalledWith("Joined circle");
    expect(invalidateCircleCache).toHaveBeenCalledWith(7n);
    expect(getCircle).toHaveBeenCalledTimes(2);

    // The refetched circle now includes the caller, so Join flips to Leave.
    expect(buttonByText(JOIN)).toBeNull();
    expect(buttonByText(LEAVE)).not.toBeNull();
  });

  it("reloads after a successful Contribute and hides the now-unneeded button", async () => {
    let paid = false;
    vi.mocked(getCircle).mockResolvedValue(makeCircle({ status: CircleStatus.Active }));
    vi.mocked(hasContributed).mockImplementation(async (_id, _cycle, member) =>
      member === ALICE ? paid : true,
    );
    // The contribution landing on-chain is what the refetch should observe.
    vi.mocked(submitSignedTx).mockImplementation(async () => {
      paid = true;
      return undefined;
    });
    setWallet(ALICE);
    await renderPage();
    expect(buttonByText(CONTRIBUTE)).not.toBeNull();

    await act(async () => {
      buttonByText(CONTRIBUTE)!.click();
    });

    expect(buildContributeTx).toHaveBeenCalledWith(7n, ALICE);
    expect(toast.success).toHaveBeenCalledWith("Contribution sent");
    expect(invalidateCircleCache).toHaveBeenCalledWith(7n);
    expect(getCircle).toHaveBeenCalledTimes(2);
    expect(buttonByText(CONTRIBUTE)).toBeNull();
  });

  it("does not reload or clear the cache when the action fails", async () => {
    vi.mocked(getCircle).mockResolvedValue(makeCircle({ creator: BOB, members: [BOB, CAROL] }));
    vi.mocked(submitSignedTx).mockRejectedValue(new Error("boom"));
    setWallet(ALICE);
    await renderPage();

    await act(async () => {
      buttonByText(JOIN)!.click();
    });

    expect(toast.error).toHaveBeenCalledWith("Could not join circle.");
    expect(toast.success).not.toHaveBeenCalled();
    expect(invalidateCircleCache).not.toHaveBeenCalled();
    expect(getCircle).toHaveBeenCalledTimes(1);
    expect(buttonByText(JOIN)).not.toBeNull();
  });
});
