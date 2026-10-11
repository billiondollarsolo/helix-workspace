import { Fragment, useId, useMemo } from "react";
import { shortcutGroups } from "./catalog";
import { detectMacPlatform, keySequenceLabels } from "./keys";

const KEY_CLASS =
  "inline-block min-w-5 text-center font-mono [font-size:var(--text-chip)] [padding:1px_6px] rounded bg-card [border:1px_solid_var(--border)] [border-bottom-width:2px] [color:var(--text-2)]";

function ShortcutKeys({ keys, isMac }: { keys: readonly string[]; isMac: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1">
      {keys.map((spec, specIndex) => (
        <Fragment key={spec}>
          {specIndex > 0 ? (
            <span className="text-muted-foreground [font-size:var(--text-caption)]">or</span>
          ) : null}
          {keySequenceLabels(spec, isMac).map((label, chordIndex) => (
            <Fragment key={`${spec}-${chordIndex}`}>
              {chordIndex > 0 ? (
                <span className="text-muted-foreground [font-size:var(--text-caption)]">then</span>
              ) : null}
              <kbd className={KEY_CLASS}>{label}</kbd>
            </Fragment>
          ))}
        </Fragment>
      ))}
    </span>
  );
}

/** Every catalog shortcut, grouped by scope. Shared by the `?` help dialog and
    Settings → Keyboard shortcuts so both always match what the app handles. */
export function ShortcutList({ columns = 1 }: { columns?: 1 | 2 }) {
  const isMac = useMemo(detectMacPlatform, []);
  const groups = shortcutGroups();
  const idPrefix = useId();
  return (
    <div className={columns === 2 ? "grid gap-x-8 gap-y-5 md:grid-cols-2" : "grid gap-5"}>
      {groups.map((group) => (
        <section key={group.scope} aria-labelledby={`${idPrefix}-${group.scope}`}>
          <h2
            id={`${idPrefix}-${group.scope}`}
            className="section-label [padding:0_0_6px] [margin:0]"
          >
            {group.label}
          </h2>
          <dl className="panel [margin:0]">
            {group.shortcuts.map((shortcut, index) => (
              <div
                key={shortcut.id}
                className={
                  index === 0
                    ? "flex flex-wrap items-center gap-x-3 gap-y-1 [padding:6px_12px]"
                    : "flex flex-wrap items-center gap-x-3 gap-y-1 [padding:6px_12px] [border-top:1px_solid_var(--border)]"
                }
              >
                <dt className="[flex:1_1_12rem] [font-size:var(--text-meta)]">
                  {shortcut.description}
                </dt>
                <dd className="[margin:0] ml-auto">
                  <ShortcutKeys keys={shortcut.keys} isMac={isMac} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}
