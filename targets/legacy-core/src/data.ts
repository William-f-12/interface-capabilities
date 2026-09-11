/** Fabricated member and account records. No real institution or person. */

export type AccountStatus = "Active" | "Restricted" | "Closed";

export interface Account {
  type: string;
  number: string;
  /** Rendered as the app displays it, e.g. "$12,480.55". */
  balance: string;
  status: AccountStatus;
}

export interface Member {
  id: string;
  firstName: string;
  lastName: string;
  memberSince: string;
  branch: string;
  /** Shown as a banner on the detail screen. */
  restricted: boolean;
  accounts: Account[];
  /** Member ids that appear alongside this one in search results. */
  jointWith: string[];
}

export const members: Member[] = [
  {
    id: "100001",
    firstName: "Margaret",
    lastName: "Chen",
    memberSince: "03/14/2009",
    branch: "Downtown",
    restricted: false,
    jointWith: ["100006"],
    accounts: [
      { type: "Savings", number: "0001-S", balance: "$12,480.55", status: "Active" },
      { type: "Checking", number: "0001-C", balance: "$2,104.19", status: "Active" },
    ],
  },
  {
    id: "100002",
    firstName: "Robert",
    lastName: "Alvarez",
    memberSince: "11/02/2015",
    branch: "Riverside",
    restricted: true,
    jointWith: [],
    accounts: [
      { type: "Savings", number: "0002-S", balance: "$3,205.00", status: "Restricted" },
      { type: "Money Market", number: "0002-M", balance: "$18,900.00", status: "Restricted" },
    ],
  },
  {
    id: "100003",
    firstName: "Dana",
    lastName: "Whitfield",
    memberSince: "06/23/2021",
    branch: "Downtown",
    restricted: false,
    jointWith: [],
    accounts: [{ type: "Savings", number: "0003-S", balance: "$87.20", status: "Active" }],
  },
  {
    id: "100004",
    firstName: "Samuel",
    lastName: "Okafor",
    memberSince: "01/09/2003",
    branch: "Northgate",
    restricted: false,
    jointWith: [],
    accounts: [
      { type: "Savings", number: "0004-S", balance: "$0.00", status: "Closed" },
      { type: "Certificate", number: "0004-T", balance: "$25,000.00", status: "Active" },
    ],
  },
  {
    id: "100005",
    firstName: "Priya",
    lastName: "Raman",
    memberSince: "08/30/2018",
    branch: "Riverside",
    restricted: false,
    jointWith: [],
    accounts: [
      { type: "Savings", number: "0005-S", balance: "$45,000.00", status: "Active" },
      { type: "Checking", number: "0005-C", balance: "$1,250.75", status: "Active" },
    ],
  },
  {
    id: "100006",
    firstName: "Thomas",
    lastName: "Chen",
    memberSince: "03/14/2009",
    branch: "Downtown",
    restricted: false,
    jointWith: ["100001"],
    accounts: [
      { type: "Savings", number: "0006-S", balance: "$640.00", status: "Active" },
    ],
  },
];

export function findById(id: string): Member | undefined {
  return members.find((m) => m.id === id);
}

/**
 * Search results include the matched member and any joint holders, so a lookup
 * by id routinely returns more than one row.
 */
export function search(memberId: string, lastName: string): Member[] {
  const matched = new Set<Member>();

  if (memberId.trim()) {
    const hit = findById(memberId.trim());
    if (hit) {
      matched.add(hit);
      for (const jointId of hit.jointWith) {
        const joint = findById(jointId);
        if (joint) matched.add(joint);
      }
    }
  }

  if (lastName.trim()) {
    const needle = lastName.trim().toLowerCase();
    for (const m of members) {
      if (m.lastName.toLowerCase().includes(needle)) matched.add(m);
    }
  }

  return [...matched].sort(
    (a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName),
  );
}

export const users: Record<string, { password: string; role: string; name: string }> = {
  teller: { password: "teller-pw", role: "teller", name: "A. Teller" },
  supervisor: { password: "supervisor-pw", role: "supervisor", name: "S. Visor" },
};
