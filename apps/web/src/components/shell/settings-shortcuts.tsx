import { cn } from "@/lib/utils";

/* ---------- Keyboard shortcuts ---------- */

export function ShortcutsSection() {
  const groups = [
    {
      name: "Global",
      shortcuts: [
        ["⌘ K", "Open command palette"],
        ["⌘ /", "Show keyboard shortcuts"],
        ["G then M", "Go to Mail"],
        ["G then C", "Go to Calendar"],
      ],
    },
    {
      name: "Mail",
      shortcuts: [
        ["C", "Compose"],
        ["E", "Archive"],
        ["#", "Delete"],
        ["R", "Reply"],
        ["A", "Reply all"],
        ["F", "Forward"],
        ["S", "Star"],
        ["B", "Snooze"],
      ],
    },
  ];
  return (
    <>
      <h1 className="[font-size:var(--text-h2)] font-semibold [margin:0_0_16px]">
        Keyboard shortcuts
      </h1>
      {groups.map((group) => (
        <div key={group.name} className="mb-6">
          <div className="section-label [padding:0_0_8px]">{group.name}</div>
          <div className="panel">
            {group.shortcuts.map(([kbd, desc], index) => (
              <div
                key={desc}
                className={cn(
                  "flex items-center [padding:8px_14px] [font-size:var(--text-meta)]",
                  index ? "[border-top:1px_solid_var(--border)]" : "[border-top:none]",
                )}
              >
                <span className="flex-1">{desc}</span>
                <span className="kbd">{kbd}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
