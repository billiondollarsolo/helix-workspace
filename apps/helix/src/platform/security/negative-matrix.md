# Negative-security matrix scaffold (G1.9)

**Status:** Scaffold — domain phases add rows; CI enforces structure via
`negative-matrix.test.ts`.

| Domain   | Actor                             | Action              | Resource                  | Expected                                     |
| -------- | --------------------------------- | ------------------- | ------------------------- | -------------------------------------------- |
| mail     | user@org-b                        | mail.thread.get     | thread in org-a           | deny                                         |
| drive    | user@org-b                        | drive.get           | file in org-a             | deny                                         |
| chat     | user@org-b                        | chat.room.subscribe | room in org-a             | deny                                         |
| agent    | agent@org-a write without confirm | tool.invoke write   | any                       | pending_confirmation or deny                 |
| origin   | browser untrusted Origin + cookie | POST /api/tools/*   | —                         | 403                                          |
| scanner  | business tier                     | drive finalize      | no-op scanner             | refuse boot / assertDriveMalwareScannerReady |
| tenant   | unauthenticated                   | request tenant      | HELIX_DEFAULT_ORG_ID only | RequestTenantIdentityError                   |
| calendar | user@org-b                        | calendar.event.get  | event in org-a            | deny (fill CAL.*)                            |
| meet     | user@org-b                        | meet.join           | room in org-a             | deny (fill MT.*)                             |
| editors  | user@org-b                        | docs.open           | file in org-a             | deny (fill ED.*)                             |
