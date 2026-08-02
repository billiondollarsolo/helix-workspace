# Full Workspace v1 packaging flag matrix (design only)

**Date:** 2026-08-02  
**Task:** G0.6  
**Status:** Design — **no enablement in this task**

## Current production MVP (enforced)

| Flag                               | Required production value   | Effect                  |
| ---------------------------------- | --------------------------- | ----------------------- |
| `HELIX_APPS`                       | `mail,drive,chat,assistant` | Server module allowlist |
| `VITE_HELIX_MVP_ONLY`              | `true`                      | Web launcher filter     |
| `HELIX_EDITORS_MIGRATIONS_ENABLED` | `false`                     | No editor migrations    |
| Disabled modules                   | explicit `false`            | Fail-closed             |

## Proposed Full Workspace v1 allowlist (after PKG.*)

| App id    | Runtime deps before enable                               | Evidence before enable |
| --------- | -------------------------------------------------------- | ---------------------- |
| mail      | managed outbound provider config; domains                | M.V / M7               |
| drive     | S3; **real ClamAV** in Business                          | D.V / D7               |
| chat      | WS origin policy; NATS as required                       | C.V / C6               |
| assistant | tool policy + pending actions                            | A.V / A7               |
| admin     | — (ops UI)                                               | ADM.V                  |
| calendar  | migrations + ACL                                         | CAL.10 after CAL.11    |
| meet      | Jitsi domain + JWT secret (compose O-D.9 or helm O-K.10) | MT.9 after MT.10       |
| docs      | helix-editors pin; Drive ACL                             | ED.11                  |
| sheets    | helix-editors pin                                        | ED.11                  |
| slides    | helix-editors pin                                        | ED.11                  |

## Fail-closed illegal combos (must boot-refuse)

| Combo                                                            | Expected              |
| ---------------------------------------------------------------- | --------------------- |
| Meet enabled, no Jitsi config                                    | refuse                |
| Drive Business, no-op scanner                                    | refuse                |
| Editors enabled, migrations true without pin/process             | refuse                |
| Production `HELIX_APPS` not matching approved allowlist for mode | refuse                |
| Data-plane ports published in production compose                 | refuse review / O-D.2 |

## Modes

| Mode  | When                     | Apps                                   |
| ----- | ------------------------ | -------------------------------------- |
| MVP   | until PKG                | mail,drive,chat,assistant (+admin UI)  |
| v1 GA | after PKG + domain gates | + calendar, meet, docs, sheets, slides |
| SaaS  | after R3, Phase S+       | multi-tenant ops                       |

## Explicit non-goals of G0.6

- Changing production defaults in code.
- Setting `VITE_HELIX_MVP_ONLY=false` on main.
