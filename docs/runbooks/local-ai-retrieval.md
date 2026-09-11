# Local AI retrieval

Open **Admin → AI retrieval** (`http://localhost:5173/admin/ai-retrieval`). Workspace retrieval and web search have independent switches. Changes are saved through the Admin API and used by subsequent requests. Connection tests use the saved settings; save a draft before testing it.

## Workspace retrieval

Choose **pgvector** to use Helix's existing PostgreSQL database, or **Qdrant** for a separately operated vector service. Both require a separate OpenAI-compatible embedding endpoint, model, and dimension. The configured Groq chat models do not provide that embedding service.

The local verification setup uses:

| Setting            | Value                               |
| ------------------ | ----------------------------------- |
| Vector backend     | pgvector                            |
| Embedding endpoint | `http://127.0.0.1:11435/v1`         |
| Embedding model    | `all-minilm`                        |
| Dimensions         | `384`                               |
| Embedding API key  | Empty for this local Ollama service |

After testing the connection, choose **Reindex workspace content**. Follow the job's status in Admin. Enabling retrieval or changing backend/model does not populate a new index. Helix names collections from the backend, embedding endpoint/model, dimensions, chunk size, and overlap, so incompatible vector spaces are not mixed. Old collections are retained; switching configuration does not delete them.

Workspace sources are split into overlapping passages. In Admin, **Chunk size (characters)** defaults to 1,024 (64–32,768) and **Chunk overlap (characters)** defaults to 15% of that size; overlap must be smaller than the size. Changing either setting requires reindexing. Use a size compatible with your embedding model's context window; character counts are not token counts. There is a 2,048-chunk ceiling per source; an oversized source fails indexing with an actionable error instead of silently truncating it.

Drive retrieval reads the entire contents of supported, scan-clean UTF-8 text/code files up to 512 KiB. It verifies stored bytes against the scanned SHA-256 and rechecks lifecycle and access after storage reads. Other formats and larger files have searchable metadata only. No PDF/Office conversion, OCR, file viewer, or editor is introduced. Explicit Assistant attachments retain the existing complete-text context path and its 5-file, 512-KiB/file, 1-MiB total, and 100,000-character limits.

Classification examines the complete source before chunking or an external embedding call. Search combines keyword ranking with the best matching passage per source; it does not automatically return every passage of a document. Each passage retains the source link, and current text/permissions are reloaded before entering the model. Changed source hashes cannot return old passage text. Reindexing a shorter document and deleting a source remove all its old passages. Status reports the active chunk settings and blocked/chunked operations since configuration load; these are not totals across the stored index. External embedding/vector services remain subject to classification and local-only policies.

Assistant retains its existing 4,000-character per-source and 12,000-character total retrieval context budgets. Keep chunks at or below 4,000 characters when the complete matching passage should fit in Assistant context; larger indexed passages are shortened when preparing a turn.

Assistant cross-conversation memory is a separate, opt-in feature with its existing 768-dimensional store. This page configures workspace search; it does not migrate old memory vectors. Memory reads and writes enforce current classification and external-provider privacy settings. With the local 384-dimensional retrieval model, memory retains its existing deterministic 768-dimensional embeddings.

## Web search

Choose **SearXNG**, endpoint `http://127.0.0.1:28461`, no key, and a result limit of 5 for the local setup. Alternatively, select **Brave Search** and supply a Brave Search API key. A Groq key cannot authenticate Brave Search.

Enable the provider, save, and test the connection. In Assistant, open **+ → Web search**. The toggle stays on for that chat until you turn it off, start a new chat, or open a conversation that last used search off. After a turn has used `web.search` or `web.fetch`, later turns in that chat keep those native tools available while web search remains enabled by the administrator, so follow-ups can replay search history. The model can then search using a concise public query and call `web.fetch` to read a public page, including a URL you provide. Web-search turns keep conversation history and explicit attachments without automatically retrieving unrelated workspace records. Search returns linked snippets. Page fetching extracts HTML/plain-text content with a bounded response and explicit continuation when necessary. Both are untrusted source data. Pages are read on demand and are not put into the workspace vector database. Sensitive conversation context prevents model-generated web queries, and the server checks admin enablement again before executing a search.

Search-provider requests go only to the configured endpoint and refuse redirects. Public page requests use a separate outbound policy: HTTPS only, private IPs/hosts blocked even in development, DNS results checked and pinned at connection time, at most three rechecked redirects, and no forwarded browser cookies/provider credentials. Each page has a 10-second deadline and 1-MiB response ceiling. HTML, XHTML, and plain text are supported; scripts, authenticated sites, PDFs, and downloads are not. The complete extracted text is classified before a 2,000-character default passage (maximum 4,000) is returned; `nextOffset` explicitly continues a longer page. SearXNG must have `json` enabled under `search.formats`; otherwise its API can return 403. [SearXNG API](https://docs.searxng.org/dev/search_api.html), [Brave authentication](https://api-dashboard.search.brave.com/documentation/guides/authentication).

## Assistant tool controls

In **Admin → AI providers**, **Maximum tool steps per reply** defaults to 128 and accepts whole numbers from 1–256. Save with the existing AI settings button. Each step is one model round that can request tools; after the last allowed round, Helix requests a final answer from the results already collected. More steps allow longer research but consume more time and tokens.

In the Assistant composer, **+ → Tools** chooses which authorized workspace tool groups the model can use. Administration and Webhooks start disabled; Web search has its own switch. Tool selection is retained with the chat. Permissions are checked by the server even when a group is selected. If too many tools are selected, choose fewer groups; Helix does not silently omit tools. Tool activity and source cards show what ran and whether a source was a search result or a page actually read.

The local saved limit is 128. Pending approvals retain the originating reply's limit and consumed rounds; approving a tool does not start a fresh budget. The Tools menu controls callable actions. Workspace search can span all records the actor may access, and automatic retrieval for ordinary chats remains governed by its separate retrieval settings.

## Services used during local verification

SearXNG ships as an optional `web-search` Compose profile. It is absent from the default startup and does not block Helix when disabled. Start only the search service:

```sh
docker compose --profile web-search up -d --wait searxng
```

The service binds to loopback port `28461` (`SEARXNG_PORT` overrides it), uses the pinned `2026.9.10-931fd9787` image digest `sha256:2fb0fa85096fe6df5c3ab98ecb4d6e0ee2ef66b8fb96ce6fce0f75b51c4bd90a`, and mounts the checked-in `infra/searxng/settings.yml` read-only. JSON output is enabled; cache data persists in the Compose `searxng-data` volume. `SEARXNG_SECRET` overrides the development-only signing secret. The `/healthz` check verifies that the service is ready without repeatedly querying external search engines. [Container configuration](https://docs.searxng.org/admin/installation-docker.html), [upstream health endpoint](https://github.com/searxng/searxng/blob/931fd9787b1517d88af2876175d8c31b03e11671/searx/webapp.py#L546).

For host-run `pnpm dev`, configure `http://127.0.0.1:28461` in Admin. For Helix running on the same Compose network, configure `http://searxng:8080`. Set the existing `HELIX_AI_ALLOW_PRIVATE_NETWORK=true` option for the local Helix process, then restart that process if the environment changed. Starting SearXNG alone does not enable web search: save **SearXNG**, the appropriate endpoint, and **Enabled** in Admin → AI retrieval, then test the connection. No search API key is needed for this local helper. A search still contacts upstream public engines; their throttling or outages can reduce results.

This checkout now uses `helix-local-dev-searxng-1` from that profile. The ignored local `.env` includes `web-search` in `COMPOSE_PROFILES` and a generated signing secret, so local infrastructure startup retains the opt-in. The earlier manually launched `helix-local-searxng` is stopped and retained for rollback; both services cannot bind the same port simultaneously. Stop only the optional service with `docker compose stop searxng`.

### Optional production SearXNG

The production overlay also offers `--profile web-search`. It publishes no search port: Helix reaches `http://searxng:8080` on the private data-plane network, while a separate network lets SearXNG contact public search engines. The service has CPU, memory, and process limits. It requires a dedicated `searxng_secret` file in `HELIX_PRODUCTION_SECRETS_DIR`; unlike local development, it has no default secret. Generate at least 32 random characters without printing them:

```sh
(umask 077; set -C; openssl rand -hex 32 > "$HELIX_PRODUCTION_SECRETS_DIR/searxng_secret")
docker compose --env-file /path/to/production.env \
  -f docker-compose.yml -f docker-compose.production.yml \
  --profile web-search up -d --wait searxng
```

Create that file only for the first deployment and retain it; the generation command refuses to overwrite an existing secret. The file is needed only when the profile is started, so leaving search disabled adds no startup prerequisite. Complete the production [deployment setup](../deployment-production.md) first. Set `HELIX_AI_ALLOW_PRIVATE_NETWORK=true` for Helix to allow the explicitly configured private endpoint, apply that environment change to Helix, then save `http://searxng:8080` and enable SearXNG in Admin. The profile does not enable Web search or relax public-page fetching rules. A separately operated HTTPS SearXNG endpoint remains an alternative.

Ollama runs separately on loopback port 11435 with cloud features disabled and models in `~/.cache/helix-local-embeddings`. To restart it in a terminal:

```sh
OLLAMA_HOST=127.0.0.1:11435 \
OLLAMA_MODELS="$HOME/.cache/helix-local-embeddings" \
OLLAMA_NO_CLOUD=true ollama serve
```

The `all-minilm` model was pulled into that isolated service. If needed, pull it again from another terminal with `OLLAMA_HOST=127.0.0.1:11435 ollama pull all-minilm`. [Ollama embedding compatibility](https://docs.ollama.com/api/openai-compatibility), [model catalog](https://ollama.com/library/all-minilm).

The ignored local `.env` sets the existing `HELIX_AI_ALLOW_PRIVATE_NETWORK=true` option for explicitly configured local AI/vector/search hosts. Restart `pnpm dev` after changing an environment option. Admin configuration changes themselves do not require a backend restart.

For the upstream design and the differences from Helix, read the [Open WebUI implementation review](../architecture/openwebui-retrieval-review.md).

## Verified locally

On 2026-09-10, saved enable/disable changes reached the runtime without changing the backend process. Both connection tests passed. A durable reindex completed 292 workspace records in one attempt, and an authenticated member received authorized hybrid results across Mail, Chat, Drive, and Calendar. A private Drive note appeared for its owner and remained absent for another member. Members were denied admin retrieval access. An earlier member session cookie remained valid through backend restarts.

Real Groq GPT-OSS20B and GPT-OSS120B Assistant turns called `web.search`, streamed answers linking the official Open WebUI documentation, and retained the exact answers when reopened. A normal GPT-OSS20B turn retrieved five authorized workspace sources and correctly cited the Harbor launch brief and team handbook. Provider errors inside HTTP200 streams now surface as errors instead of being saved as empty answers; native function names and the generated tool catalog use consistent provider-compatible aliases.

The earlier admin weather regression exposed an oversized tool catalog and a missing final-answer step after the tool budget. Its initial fix selected at most 128 authorized tools and converted historical results into untrusted text for final synthesis. The native tool follow-up supersedes that workaround: explicit group selection bounds the catalog, matched native call/result pairs remain in history, and `tool_choice: none` disables further calls for the final answer. Browser time zones are validated against the server clock to resolve relative dates. After migrating to the shipped SearXNG service and saving its connection through Admin, the exact admin prompt `whats teh weather tomorrow in 20882` completed with three searches, streamed a nonempty answer, and retained it on reopen. This verifies the integration; search snippets and model-generated forecasts still require source/date verification. Evidence is stored outside Git under `helix-release-backups/2026-09-10/local-delivery-evidence/weather-searxng`.

After adding full-page fetching and chunks, a normal Drive upload passed scanning and a durable reindex completed 293 source records. A semantic query retrieved the rescue details from passage 4 of a 2,967-byte text file; a second user could not retrieve that private source. A real Groq GPT-OSS20B turn executed `web.fetch` against the Open WebUI agentic-search guide, streamed a linked answer, and persisted it on reopen. Direct tool requests also verified continuation through its 14,236 characters and rejection of a loopback destination. Evidence is stored outside Git under `helix-release-backups/2026-09-10/local-delivery-evidence/account-handoff-chunks`.

The native-tool follow-up saved and read back the requested 128-round limit through the Admin API, preserving providers and search configuration. GPT-OSS20B completed 19 search/fetch calls, including recovery from two HTTP 404 page responses, then produced an answer containing an exact returned source URL. Answer, sources, and activity survived reopen. GPT-OSS120B completed the original weather prompt with two searches and three fetch attempts, recovered from the 1-MiB page ceiling, and returned a dated answer with five source cards, including two pages read. These are integration checks, not an independent certification of forecast accuracy. Final evidence is in `helix-release-backups/2026-09-10/local-delivery-evidence/openwebui-tool-use` and the adjacent `tool-ux` browser archive.
