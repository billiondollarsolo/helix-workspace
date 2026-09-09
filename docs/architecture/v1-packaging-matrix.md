# Workspace v1 packaging

The product contains Mail, Drive file storage, Chat, Calendar, Meet, Assistant,
and Admin. There are no editors, viewers, converters, or editor package dependencies.
Drive supports uploads, folders, versions, sharing, downloads, and WebDAV.

Production profiles retain explicit deployment gates:

| Profile | Backend apps                              |
| ------- | ----------------------------------------- |
| `mvp`   | `mail,drive,chat,assistant`               |
| `full`  | `mail,drive,chat,assistant,calendar,meet` |

Admin is the operations UI. The web application contains all supported product
surfaces; backend app status controls availability. There is no alternate editor build.

Meet requires a configured Jitsi domain and JWT credentials. Business-tier Drive
requires real malware scanning and tenant-scoped object storage. Mail delivery
requires its configured provider and domain evidence. Expanding a production
profile still requires the deployment and recovery evidence described in
[HA and recovery](ha-rpo-rto.md).
