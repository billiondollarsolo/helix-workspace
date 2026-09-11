import { LOCAL_TEAM_PEOPLE, teamId, teamPerson, type TeamPerson } from "./local-team-fixtures.js";

function fid(index: number): string {
  return teamId(1, index);
}

export interface TeamFileFixture {
  readonly key: string;
  readonly owner: TeamPerson;
  readonly folderId: string | null;
  readonly name: string;
  readonly mimeType: string;
  readonly body: string;
}

function fileBody(title: string, owner: TeamPerson, extra: string): string {
  return `# ${title}\n\nOwner: ${owner.displayName} (${owner.jobTitle})\nUpdated: Harbor pilot week\n\n${extra}\n`;
}

function personOf(owner: TeamPerson | number): TeamPerson {
  return typeof owner === "number" ? teamPerson(owner) : owner;
}

function md(
  key: string,
  owner: TeamPerson | number,
  folderId: string | null,
  name: string,
  extra: string,
): TeamFileFixture {
  const person = personOf(owner);
  return {
    key,
    owner: person,
    folderId,
    name,
    mimeType: "text/markdown",
    body: fileBody(name.replace(/\.md$/, ""), person, extra),
  };
}

function csv(
  key: string,
  owner: TeamPerson | number,
  folderId: string | null,
  name: string,
  body: string,
): TeamFileFixture {
  return { key, owner: personOf(owner), folderId, name, mimeType: "text/csv", body };
}

function txt(
  key: string,
  owner: TeamPerson | number,
  folderId: string | null,
  name: string,
  body: string,
): TeamFileFixture {
  return { key, owner: personOf(owner), folderId, name, mimeType: "text/plain", body };
}

function jsonFile(
  key: string,
  owner: TeamPerson | number,
  folderId: string | null,
  name: string,
  value: unknown,
): TeamFileFixture {
  return {
    key,
    owner: personOf(owner),
    folderId,
    name,
    mimeType: "application/json",
    body: `${JSON.stringify(value, null, 2)}\n`,
  };
}
export function teamFileFixtures(): readonly TeamFileFixture[] {
  const personal = LOCAL_TEAM_PEOPLE.flatMap((person) => [
    md(
      `${String(person.index)}-brief`,
      person,
      person.folderId,
      `${person.documentTitle}.md`,
      `## Outcome\nHelp the Harbor pilot coordinate work across Mail, Drive, and Chat.\n\n## This week\n- Review customer feedback with Elena and Nora.\n- Check ${person.focus}.\n- Bring one concrete improvement to Thursday's readiness review.\n\n## Acceptance checks\n- Every change has an owner and a next step.\n- Private drafts stay private until the intended people can open them.\n`,
    ),
    csv(
      `${String(person.index)}-tasks`,
      person,
      person.folderId,
      "Weekly priorities.csv",
      `priority,task,owner,status\n1,Finish ${person.documentTitle},${person.displayName},in progress\n2,Review pilot feedback,${person.displayName},ready\n3,Share Thursday update,${person.displayName},planned\n`,
    ),
    txt(
      `${String(person.index)}-notes`,
      person,
      null,
      `${person.firstName}'s working notes.txt`,
      `${person.displayName} — personal working notes\n\nMy focus: ${person.focus}.\n\nMonday: smallest useful pilot.\nTuesday: collect a successful test and a useful failure.\nWednesday: ask a teammate to try the flow.\nThursday: review readiness.\nFriday: write down what we learned.\n\nPrivate reminder: do not share this file yet.\n`,
    ),
    md(
      `${String(person.index)}-draft-notes`,
      person,
      fid(11 + person.index),
      "Scratch meeting notes.md",
      `Not ready to share.\n\n- Open question about ${person.focus}.\n- Need one example a teammate can follow without extra setup.\n`,
    ),
    csv(
      `${String(person.index)}-draft-checklist`,
      person,
      fid(11 + person.index),
      "Personal checklist.csv",
      `item,done\nRead shared handbook,yes\nUpdate ${person.documentTitle},no\nAsk a reviewer,no\n`,
    ),
    md(
      `${String(person.index)}-archive-recap`,
      person,
      fid(21 + person.index),
      "Last week recap.md",
      `Shipped a first draft of ${person.documentTitle.toLowerCase()}. Kept the working notes private. Next: one review from a teammate.\n`,
    ),
    md(
      `${String(person.index)}-meeting-recap`,
      person,
      fid(31 + person.index),
      "Personal meeting recap.md",
      `Attendees: ${person.displayName} and a reviewer.\nDecision needed: whether ${person.focus} is ready to share.\nFollow-up: update the working file before Thursday.\n`,
    ),
  ]);
  return [
    ...personal,
    ...sharedTeamFiles(),
    ...launchFiles(),
    ...engineeringFiles(),
    ...productPlanningFiles(),
    ...pairFiles(),
  ];
}

function sharedTeamFiles(): TeamFileFixture[] {
  const people = LOCAL_TEAM_PEOPLE.map(
    (person) => `- ${person.displayName}: ${person.jobTitle} (${person.email})`,
  ).join("\n");
  const customers: Array<
    readonly [key: string, folder: number, owner: number, name: string, note: string]
  > = [
    [
      "northstar",
      151,
      4,
      "Northstar Health",
      "Admin needs a named owner on every shared file. Confused personal vs shared folders.",
    ],
    [
      "ridgeway",
      152,
      4,
      "Ridgeway Schools",
      "Teachers share class folders with a small staff group. Access-denied copy must say who to ask.",
    ],
    [
      "brightline",
      153,
      0,
      "Brightline Logistics",
      "Ops lead wants a restore check before inviting warehouse supervisors.",
    ],
  ];
  return [
    md(
      "shared-handbook",
      0,
      fid(101),
      "Harbor team handbook.md",
      `We run a small customer pilot with ten fictional coworkers.\n\n## Working together\nUse Mail for decisions that need a durable answer. Use Chat for a quick clarification. Keep working documents in Drive and share only with the people who need them.\n\n## Weekly rhythm\nMonday planning, Thursday readiness review, Friday learning notes.\n\n## People\n${people}\n`,
    ),
    csv(
      "shared-milestones",
      0,
      fid(101),
      "Pilot milestones.csv",
      "milestone,owner,status\nScope agreed,Samara Malik,complete\nDesign review,Imani Reed,in progress\nAccess review,Priya Shah,planned\nCustomer rehearsal,Elena Costa,planned\nLaunch note,Mateo Silva,draft\n",
    ),
    md(
      "shared-glossary",
      9,
      fid(101),
      "Harbor glossary.md",
      "Pilot: the ten-person Harbor workspace.\nShared folder: visible to named people.\nPersonal notes: visible only to the owner until shared.\nReader: can open, cannot edit.\n",
    ),
    md(
      "shared-onboarding",
      4,
      fid(101),
      "Onboarding checklist.md",
      "1. Sign in.\n2. Open Harbor team resources.\n3. Send one internal mail.\n4. Confirm you cannot open someone else's working notes.\n",
    ),
    csv(
      "shared-office-hours",
      9,
      fid(101),
      "Office hours.csv",
      "day,host,topic\nMonday,Samara Malik,Scope and owners\nWednesday,Elena Costa,Customer questions\nFriday,Avery Park,Access problems\n",
    ),
    md(
      "kickoff-agenda",
      0,
      fid(111),
      "Kickoff agenda.md",
      "1. Scope and non-goals\n2. Who can open which folders\n3. First internal mail and Chat check\n4. Thursday review owners\n",
    ),
    csv(
      "kickoff-attendees",
      0,
      fid(111),
      "Kickoff attendees.csv",
      `name,role,confirmed\n${LOCAL_TEAM_PEOPLE.map((person) => `${person.displayName},${person.jobTitle},yes`).join("\n")}\nAvery Park,Workspace admin,yes\n`,
    ),
    md(
      "weekly-1",
      0,
      fid(112),
      "Week 1 overview.md",
      "We agreed the pilot is a real exchange: mail, shared file, chat clarification, calendar follow-up.\nOpen: empty states and access-failure copy.\n",
    ),
    md(
      "weekly-2",
      9,
      fid(112),
      "Week 2 overview.md",
      "Customer rehearsal moved to Friday. Mateo will draft the launch note after Elena confirms the onboarding path.\n",
    ),
    ...[1, 2, 3].flatMap((week) => [
      md(
        `weekly-week-${String(week)}`,
        week === 2 ? 9 : 0,
        fid(140 + week),
        `Week ${String(week)} notes.md`,
        week === 1
          ? "Decided: keep personal notes unfiled until they are ready.\nFollow-up: Elena will try the onboarding checklist from a fresh session."
          : week === 2
            ? "Northstar interview: people look for the owner first.\nFollow-up: put the owner on the first line of shared docs."
            : "Access review scheduled with Priya.\nFollow-up: Luca will confirm seat counts before we invite the next customer.",
      ),
      csv(
        `weekly-week-${String(week)}-actions`,
        week === 3 ? 7 : 0,
        fid(140 + week),
        `Week ${String(week)} actions.csv`,
        `item,owner,status\nShare handbook,Mateo Silva,${week === 1 ? "done" : "done"}\nCustomer rehearsal,Elena Costa,${week === 3 ? "ready" : "in progress"}\nAccess review,Priya Shah,${week === 3 ? "in progress" : "planned"}\n`,
      ),
    ]),
    md(
      "template-status",
      9,
      fid(113),
      "Status update template.md",
      "This week:\n- Done\n- In progress\n- Blocked\n\nDecision needed:\nOwner:\n",
    ),
    md(
      "template-decision",
      0,
      fid(113),
      "Decision log template.md",
      "Decision:\nDate:\nOwner:\nWhy:\nFollow-up:\n",
    ),
    md(
      "template-interview",
      6,
      fid(113),
      "Interview notes template.md",
      "Participant:\nDate:\nQuote:\nImplication:\nOwner of the follow-up:\n",
    ),
    md(
      "meeting-monday-agenda",
      0,
      fid(144),
      "Monday planning agenda.md",
      "1. What shipped last week\n2. One customer quote\n3. Owners for Thursday\n",
    ),
    csv(
      "meeting-monday-notes",
      0,
      fid(144),
      "Monday attendees.csv",
      "name,role,present\nSamara Malik,Product lead,yes\nTheo Brooks,Platform engineer,yes\nElena Costa,Customer success lead,yes\nAvery Park,Workspace admin,yes\n",
    ),
    md(
      "meeting-thursday-agenda",
      0,
      fid(145),
      "Thursday review agenda.md",
      "Bring one decision, not a long status report. Record a useful failure if someone cannot open a shared file.\n",
    ),
    csv(
      "meeting-thursday-decisions",
      0,
      fid(145),
      "Thursday decisions.csv",
      "decision,owner,status\nKeep personal notes private,Samara Malik,agreed\nInvite Northstar after access review,Elena Costa,planned\n",
    ),
    md(
      "playbook-mail",
      4,
      fid(115),
      "Internal mail playbook.md",
      "Send decisions in Mail. Put the owner in the first sentence. Link the Drive file instead of pasting the draft.\n",
    ),
    md(
      "playbook-sharing",
      8,
      fid(115),
      "Drive sharing playbook.md",
      "Share the folder when the whole project is shared. Share the file when only one document should move. Do not put restricted notes inside a company-wide folder.\n",
    ),
    md(
      "archive-week-0",
      9,
      fid(116),
      "Week 0 kickoff recap.md",
      "Harbor exists to prove a real internal workspace: mail, files, chat, and calendar with honest permissions.\n",
    ),
    ...customers.flatMap(([key, folderIndex, owner, name, note]) => [
      md(
        `customer-${key}-brief`,
        owner,
        fid(folderIndex),
        `${name} brief.md`,
        `Fictional customer for the Harbor pilot.\n\n${note}\n\nNext step: Elena confirms they can open the shared onboarding folder and cannot open personal notes.\n`,
      ),
      csv(
        `customer-${key}-contacts`,
        owner,
        fid(folderIndex),
        `${name} contacts.csv`,
        `name,role,status\n${name} admin,Workspace admin,invited\n${name} lead,Team lead,briefed\n`,
      ),
    ]),
  ];
}

function launchFiles(): TeamFileFixture[] {
  return [
    md(
      "private-decision",
      0,
      fid(102),
      "Pilot scope decision.md",
      "Private working draft for Samara, Theo, and Imani.\n\nWe will invite a small team first. The acceptance test is a real exchange: send an internal mail, review a shared file, clarify it in Chat, and record the next meeting.\n\nOpen decisions: invitation timing, clear empty states, and how to explain access failures.\n\nDecision owner: Samara. Engineering review: Theo. Design review: Imani.\n",
    ),
    md(
      "launch-spec",
      1,
      fid(122),
      "Acceptance spec.md",
      "A teammate can send mail, open the intended folder, fail to open a private note, and say who to ask next.\n",
    ),
    jsonFile("launch-flags", 1, fid(122), "pilot-flags.json", {
      inviteNorthstar: false,
      requireAccessReview: true,
      showDeniedOwner: true,
    }),
    md(
      "decision-risks",
      0,
      fid(123),
      "Launch risks.md",
      "Private working draft.\n\n1. A teammate cannot open the intended folder.\n2. An invitation goes to the wrong domain.\n3. The empty state does not explain the next step.\n",
    ),
    csv(
      "decision-log",
      0,
      fid(121),
      "Decision log.csv",
      "date,decision,owner\nMon,Personal notes stay unfiled,Samara Malik\nTue,Engineering handover is a separate root,Theo Brooks\n",
    ),
  ];
}

function engineeringFiles(): TeamFileFixture[] {
  return [
    md(
      "engineering-runbook",
      1,
      fid(103),
      "Pilot operations runbook.md",
      "Owners: Theo, Jun, Omar, and Priya. Luca may read this folder for seat-count planning.\n\nBefore a change: restore a backup, repeat the permission matrix, check service health.\nIf a check fails, stop the rollout and keep the previous version available.\n",
    ),
    md(
      "runbook-restore",
      1,
      fid(161),
      "Restore check.md",
      "1. Restore yesterday's backup to the staging workspace.\n2. Open Mail, Drive, and Chat as Samara and as Theo.\n3. Confirm private notes stay private.\n",
    ),
    csv(
      "runbook-restore-log",
      5,
      fid(161),
      "Restore log.csv",
      "date,operator,result\nTue,Omar Haddad,pass\nWed,Theo Brooks,pass\n",
    ),
    md(
      "runbook-deploy",
      3,
      fid(162),
      "Deploy checklist.md",
      "1. Scan-clean Drive fixtures.\n2. Repeat the permission matrix.\n3. Watch mail delivery for 15 minutes.\n",
    ),
    md(
      "incident-mail-delay",
      5,
      fid(163),
      "Incident mail delay.md",
      "Symptom: Harbor review mail arrived 12 minutes late.\nAction: checked the receiving domain, retried delivery, recorded the owner.\n",
    ),
    csv(
      "incident-index",
      5,
      fid(132),
      "Incident index.csv",
      "id,title,owner,status\nINC-14,Internal mail delay,Omar Haddad,closed\nINC-15,Denied-state copy missing owner,Priya Shah,open\n",
    ),
    md(
      "architecture-notes",
      1,
      fid(133),
      "Workspace topology.md",
      "Ten people, two mail domains, personal Drive roots, shared project folders, and pair-share working folders. Restricted work is a separate root so it does not inherit company-wide access.\n",
    ),
    jsonFile("eng-health", 1, fid(133), "service-health.json", {
      mail: "ok",
      drive: "ok",
      chat: "ok",
      calendar: "ok",
      checkedBy: "Theo Brooks",
    }),
  ];
}

function productPlanningFiles(): TeamFileFixture[] {
  return [
    md(
      "research-northstar",
      6,
      fid(171),
      "Northstar interview.md",
      "Participant: fictional customer lead.\nQuote: I need to know who owns the next step without asking in three places.\nImplication: put the owner on the shared file and the mail thread.\n",
    ),
    csv(
      "research-quotes",
      6,
      fid(171),
      "Interview quotes.csv",
      "customer,quote,theme\nNorthstar,Who owns this file?,ownership\nRidgeway,The denied page should name a person,access copy\n",
    ),
    md(
      "copy-outline",
      9,
      fid(172),
      "Launch copy outline.md",
      "Subject: Harbor pilot starts Thursday.\nPromise: a shared folder, a lounge room, and one admin to ask.\nDo not promise features we have not accepted.\n",
    ),
    md(
      "onboarding-script",
      4,
      fid(173),
      "Customer onboarding script.md",
      "1. Sign in with the invited address.\n2. Open Harbor team resources.\n3. Send Elena one mail from the harbor.local alias.\n",
    ),
    md(
      "planning-budget",
      7,
      fid(181),
      "Seat count notes.md",
      "Ten Harbor seats plus the workspace admin. Next customer adds five seats after the access review.\n",
    ),
    csv(
      "planning-timeline",
      0,
      fid(182),
      "Pilot timeline.csv",
      "week,outcome,owner\n1,Internal exchange works,Samara Malik\n2,Customer rehearsal,Elena Costa\n3,Access review,Priya Shah\n",
    ),
    md(
      "cs-playbook",
      4,
      fid(191),
      "Pilot customer playbook.md",
      "If a customer cannot open a folder, ask who it was shared with before resetting anything. Record the useful failure in Thursday review.\n",
    ),
    csv(
      "cs-interviews",
      6,
      fid(192),
      "Interview tracker.csv",
      "date,participant,interviewer,insight\nMon,Northstar admin,Nora Patel,Needs a clear owner on every file\nTue,Ridgeway lead,Elena Costa,Confused by personal vs shared folders\n",
    ),
  ];
}

function pairFiles(): TeamFileFixture[] {
  return [
    md(
      "pair-customer-brief",
      0,
      fid(201),
      "Customer briefing.md",
      "Shared with Elena only.\nTalking points: what the pilot is, who to ask, how to report a blocked file.\n",
    ),
    csv(
      "pair-customer-questions",
      4,
      fid(201),
      "Customer questions.csv",
      "question,owner,status\nWho sees my files?,Elena Costa,open\nHow do I invite a teammate?,Samara Malik,open\n",
    ),
    md(
      "pair-design-handoff",
      2,
      fid(202),
      "Design-eng handoff.md",
      "Empty states, access-denied copy, and the share dialog. Jun will implement the smallest version that matches these notes.\n",
    ),
    csv(
      "pair-design-tickets",
      3,
      fid(202),
      "Handoff tickets.csv",
      "id,item,owner,status\nH-14,Share dialog labels,Jun Park,in progress\nH-15,Denied-state copy,Imani Reed,review\n",
    ),
    csv(
      "pair-interviews",
      6,
      fid(203),
      "Interview tracker.csv",
      "date,participant,interviewer,insight\nMon,Pilot admin,Nora Patel,Needs a clear owner on every file\nTue,Pilot lead,Elena Costa,Confused by personal vs shared folders\n",
    ),
    md(
      "pair-interview-northstar",
      6,
      fid(203),
      "Northstar raw notes.md",
      "Do not share outside this folder. The admin asked whether a forwarded mail grants Drive access. It does not.\n",
    ),
    md(
      "pair-budget",
      7,
      fid(204),
      "Pilot budget notes.md",
      "Shared with Samara. Keep contractor hours and seat counts in this folder only.\n",
    ),
    csv(
      "pair-budget-lines",
      7,
      fid(204),
      "Budget lines.csv",
      "item,amount,owner\nPilot seats,10,Luca Rossi\nStaging restore time,6h,Omar Haddad\n",
    ),
    csv(
      "pair-access",
      8,
      fid(205),
      "Access matrix.csv",
      "resource,samara,theo,elena,avery\nTeam resources,edit,edit,edit,edit\nPersonal notes,owner,none,none,none\nLaunch working files,owner,edit,none,edit\n",
    ),
    md(
      "pair-access-findings",
      8,
      fid(205),
      "Access review findings.md",
      "No unexpected grants on personal working notes. Pair-share customer briefing is not visible to Priya or Avery.\n",
    ),
    md(
      "pair-copy",
      9,
      fid(206),
      "Launch email draft.md",
      "Shared with Elena. Subject: Harbor pilot starts Thursday.\nBody: you will get a shared folder, a lounge room, and one admin to ask.\n",
    ),
    md(
      "pair-oncall",
      3,
      fid(207),
      "On-call log.md",
      "Tue 21:14 — mail delay, Omar investigating.\nTue 21:26 — delivery caught up. No customer impact.\n",
    ),
    csv(
      "pair-oncall-roster",
      5,
      fid(207),
      "On-call roster.csv",
      "week,primary,backup\n1,Jun Park,Omar Haddad\n2,Omar Haddad,Priya Shah\n",
    ),
    md(
      "pair-synthesis",
      0,
      fid(208),
      "Research synthesis.md",
      "Shared with Nora. People look for the owner first, then the file. Put names on folders and on the first line of each doc.\n",
    ),
    md(
      "trio-product-brief",
      0,
      fid(209),
      "Product trio notes.md",
      "Samara, Imani, and Nora only. Decision: empty states should name the owner of the next step.\n",
    ),
    md(
      "war-room-checklist",
      0,
      fid(210),
      "Launch war room.md",
      "Visible to Samara, Theo, Imani, and Avery.\nGo/no-go: restore check, permission matrix, one successful customer rehearsal.\n",
    ),
    csv(
      "war-room-owners",
      1,
      fid(210),
      "Go-live owners.csv",
      "check,owner,status\nRestore,Omar Haddad,pass\nPermissions,Priya Shah,in progress\nRehearsal,Elena Costa,planned\n",
    ),
    md(
      "security-review",
      8,
      fid(211),
      "Security review.md",
      "Least privilege holds for personal notes. Shared team resources include Avery as editor. Finance close is Luca and Avery only.\n",
    ),
    md(
      "comms-calendar",
      9,
      fid(212),
      "Comms calendar.md",
      "Monday: internal status. Wednesday: customer FAQ. Friday: launch note if the access review is green.\n",
    ),
    csv(
      "finance-close",
      7,
      fid(213),
      "Seat invoice.csv",
      "month,seats,notes\nSeptember,11,ten Harbor people plus Avery\nOctober,16,add Northstar only after access review\n",
    ),
    md(
      "finance-close-notes",
      7,
      fid(213),
      "Finance close notes.md",
      "Avery can edit this folder. Do not copy these numbers into the company-wide handbook.\n",
    ),
    md(
      "design-system",
      2,
      fid(214),
      "Denied-state copy.md",
      "Title: You do not have access.\nBody: This file is limited to a smaller group. Ask the owner named on the folder.\n",
    ),
    csv(
      "design-system-tickets",
      3,
      fid(214),
      "Design tickets.csv",
      "id,item,owner,status\nD-21,Denied-state owner name,Imani Reed,review\nD-22,Share dialog labels,Jun Park,in progress\n",
    ),
    md(
      "ops-capacity",
      5,
      fid(215),
      "Ops capacity.md",
      "On-call is Jun and Omar this week. Priya reviews access changes before they ship.\n",
    ),
    md(
      "cs-working-faq",
      4,
      fid(216),
      "Customer FAQ.md",
      "Q: Does forwarding mail share the file?\nA: No. Share the folder or the file in Drive.\n",
    ),
    md(
      "research-design",
      6,
      fid(217),
      "Research-design notes.md",
      "Nora and Imani only. The denied page should not expose the file name of a private note.\n",
    ),
    csv(
      "vendor-hours",
      7,
      fid(218),
      "Vendor hours.csv",
      "vendor,hours,owner\nRestore drills,6,Omar Haddad\nAccess review,4,Priya Shah\n",
    ),
  ];
}
