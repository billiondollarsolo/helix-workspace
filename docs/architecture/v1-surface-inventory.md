# Helix 1.0 surface inventory

The [canonical 1.0 scope](../release/1.0-scope.md) replaces earlier proposed inventories.

| Surface   | 1.0 status | Runtime                                      |
| --------- | ---------- | -------------------------------------------- |
| Mail      | Shipped    | Managed provider, web and API clients        |
| Drive     | Shipped    | Storage, versions, shares, downloads, WebDAV |
| Chat      | Shipped    | Organization and room authorization          |
| Assistant | Shipped    | Authorized reads, confirmed writes           |
| Admin     | Shipped    | Authenticated control surface                |
| Calendar  | Dormant    | Full profile only                            |
| Meet      | Dormant    | Full profile with Jitsi dependency gates     |

Production uses `HELIX_APPS=mail,drive,chat,assistant` and `VITE_HELIX_MVP_ONLY=true`.
