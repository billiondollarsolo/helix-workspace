import { LOCAL_TEAM_PEOPLE, teamId } from "./local-team-fixtures.js";

const allMembers = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
const productCrew = [0, 2, 4, 6, 9] as const;
const engineeringCrew = [1, 3, 5, 8] as const;
const planningCrew = [0, 4, 7, 9] as const;
const customerCrew = [4, 6, 9] as const;
const launchCrew = [0, 1, 2] as const;

function fid(index: number): string {
  return teamId(1, index);
}

export interface TeamFolderFixture {
  readonly id: string;
  readonly name: string;
  readonly owner: number;
  readonly members: readonly number[];
  readonly readers?: readonly number[];
  readonly parentId?: string;
  readonly includeAdmin?: boolean | "editor" | "reader";
}

export interface TeamFileShare {
  readonly fileKey: string;
  readonly members?: readonly number[];
  readonly readers?: readonly number[];
  readonly includeAdmin?: boolean | "editor" | "reader";
}

function folder(
  index: number,
  name: string,
  owner: number,
  members: readonly number[],
  extra: Omit<TeamFolderFixture, "id" | "name" | "owner" | "members"> = {},
): TeamFolderFixture {
  return { id: fid(index), name, owner, members, ...extra };
}

function child(
  index: number,
  name: string,
  parent: TeamFolderFixture,
  extra: Partial<Omit<TeamFolderFixture, "id" | "name" | "parentId">> = {},
): TeamFolderFixture {
  return {
    id: fid(index),
    name,
    owner: extra.owner ?? parent.owner,
    members: extra.members ?? parent.members,
    parentId: parent.id,
    ...((extra.readers ?? parent.readers) ? { readers: extra.readers ?? parent.readers } : {}),
    ...((extra.includeAdmin ?? parent.includeAdmin)
      ? { includeAdmin: extra.includeAdmin ?? parent.includeAdmin }
      : {}),
  };
}

export function teamFolderFixtures(): readonly TeamFolderFixture[] {
  const personal = LOCAL_TEAM_PEOPLE.flatMap((person) => {
    const root = folder(person.index + 1, `${person.firstName}'s Harbor projects`, person.index, [
      person.index,
    ]);
    return [
      root,
      child(11 + person.index, "Drafts", root),
      child(21 + person.index, "Archive", root),
      child(31 + person.index, "Meeting notes", root),
    ];
  });
  const teamResources = folder(101, "Harbor team resources", 0, allMembers, {
    includeAdmin: true,
  });
  const launch = folder(102, "Harbor private launch working files", 0, launchCrew, {
    includeAdmin: true,
  });
  const engineering = folder(103, "Harbor engineering handover", 1, engineeringCrew, {
    includeAdmin: true,
    readers: [7],
  });
  const product = folder(104, "Harbor product library", 0, productCrew, { includeAdmin: true });
  const planning = folder(105, "Harbor planning", 7, planningCrew, { includeAdmin: true });
  const success = folder(106, "Harbor customer success", 4, customerCrew, { includeAdmin: true });
  const weekly = child(112, "Weekly notes", teamResources);
  const meetings = child(114, "Meetings", teamResources);
  const customers = child(117, "Customers", teamResources);
  const runbooks = child(131, "Runbooks", engineering);
  const incidents = child(132, "Incidents", engineering);
  const nested = [
    child(111, "Kickoff", teamResources),
    weekly,
    child(113, "Templates", teamResources, { owner: 9 }),
    meetings,
    child(115, "Playbooks", teamResources, { owner: 4 }),
    child(116, "Archive", teamResources, { owner: 9 }),
    customers,
    child(141, "Week 1", weekly),
    child(142, "Week 2", weekly, { owner: 9 }),
    child(143, "Week 3", weekly),
    child(144, "Monday planning", meetings),
    child(145, "Thursday review", meetings),
    child(151, "Northstar Health", customers, { owner: 4 }),
    child(152, "Ridgeway Schools", customers, { owner: 4 }),
    child(153, "Brightline Logistics", customers),
    child(121, "Decisions", launch),
    child(122, "Specs", launch, { owner: 1 }),
    child(123, "Risks", launch),
    runbooks,
    incidents,
    child(133, "Architecture", engineering),
    child(161, "Restore", runbooks),
    child(162, "Deploy", runbooks, { owner: 3 }),
    child(163, "September", incidents, { owner: 5 }),
    child(171, "Research", product, { owner: 6 }),
    child(172, "Copy drafts", product, { owner: 9 }),
    child(173, "Onboarding", product, { owner: 4 }),
    child(181, "Budget", planning),
    child(182, "Timeline", planning, { owner: 0 }),
    child(191, "Playbooks", success),
    child(192, "Interviews", success, { owner: 6 }),
  ];
  const pairs = [
    folder(201, "Customer briefing — Samara & Elena", 0, [0, 4]),
    folder(202, "Design-eng handoff — Imani & Jun", 2, [2, 3]),
    folder(203, "Interview notes — Nora & Elena", 6, [6, 4]),
    folder(204, "Budget working — Luca & Samara", 7, [7, 0]),
    folder(205, "Access reviews — Priya & Theo", 8, [8, 1]),
    folder(206, "Launch copy — Mateo & Elena", 9, [9, 4]),
    folder(207, "On-call notes — Jun & Omar", 3, [3, 5]),
    folder(208, "Research synthesis — Samara & Nora", 0, [0, 6]),
    folder(209, "Product trio — Samara, Imani, Nora", 0, [0, 2, 6]),
    folder(210, "Launch war room", 0, launchCrew, { includeAdmin: true }),
    folder(211, "Security review — Priya, Omar, Theo", 8, [8, 5, 1]),
    folder(212, "Comms working — Mateo, Elena, Samara", 9, [9, 4, 0]),
    folder(213, "Finance close — Luca & Avery", 7, [7], { includeAdmin: "editor" }),
    folder(214, "Design system — Imani, Jun, Mateo", 2, [2, 3, 9]),
    folder(215, "Ops working — Jun, Omar, Priya", 5, [3, 5, 8]),
    folder(216, "CS working — Elena, Nora, Mateo", 4, [4, 6, 9]),
    folder(217, "Research + design — Nora & Imani", 6, [6, 2]),
    folder(218, "Vendor hours — Luca & Omar", 7, [7, 5]),
  ];
  return [
    ...personal,
    teamResources,
    launch,
    engineering,
    product,
    planning,
    success,
    ...nested,
    ...pairs,
  ];
}

export function teamFileShares(): readonly TeamFileShare[] {
  return [
    { fileKey: "0-brief", members: [4], includeAdmin: "reader" },
    { fileKey: "1-brief", members: [8] },
    { fileKey: "2-brief", members: [3] },
    { fileKey: "3-brief", members: [1] },
    { fileKey: "4-brief", members: [9] },
    { fileKey: "5-brief", members: [8] },
    { fileKey: "6-brief", members: [0, 4] },
    { fileKey: "7-brief", members: [0], readers: [9] },
    { fileKey: "8-brief", members: [1] },
    { fileKey: "9-brief", members: [4] },
    { fileKey: "0-tasks", readers: [1] },
    { fileKey: "4-tasks", readers: [0] },
  ];
}

export function adminFolderRole(folder: TeamFolderFixture): "editor" | "reader" | null {
  if (folder.includeAdmin === "reader") return "reader";
  if (folder.includeAdmin === true || folder.includeAdmin === "editor") return "editor";
  return null;
}

export function adminFileShareRole(share: TeamFileShare): "editor" | "reader" | null {
  if (share.includeAdmin === "reader") return "reader";
  if (share.includeAdmin === true || share.includeAdmin === "editor") return "editor";
  return null;
}

export { teamFileFixtures, type TeamFileFixture } from "./local-team-drive-files.js";
