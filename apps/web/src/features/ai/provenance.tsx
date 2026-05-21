import { BadgeInfo, Bot, Clock3, Database, Hash, Route, Sparkles, Wrench } from "lucide-react";
import { useMemo, useState } from "react";

export type AIProvenanceClassification = "public" | "standard" | "confidential" | "restricted";

export interface AIProvenanceSource {
  id: string;
  title: string;
  type: string;
  reference?: string;
}

export interface AIProvenanceToolCall {
  id: string;
  name: string;
  status: "succeeded" | "skipped" | "failed";
  summary?: string;
}

export interface AIProvenanceArtifact {
  artifactId: string;
  feature: string;
  providerId: string;
  model: string;
  promptHash: string;
  createdAt: string;
  actorName: string;
  classification?: AIProvenanceClassification;
  inputTokens?: number;
  outputTokens?: number;
  costUsdMicros?: number;
  latencyMs?: number;
  traceId?: string;
  tools?: readonly AIProvenanceToolCall[];
  sources?: readonly AIProvenanceSource[];
}

interface AIProvenanceBadgeProps {
  provenance: AIProvenanceArtifact;
  compact?: boolean;
}

interface AIProvenanceDetailsProps {
  provenance: AIProvenanceArtifact;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function formatCost(micros: number | undefined) {
  if (micros === undefined) {
    return "Not recorded";
  }

  return new Intl.NumberFormat(undefined, {
    currency: "USD",
    maximumFractionDigits: 6,
    style: "currency"
  }).format(micros / 1_000_000);
}

function formatTokens(inputTokens: number | undefined, outputTokens: number | undefined) {
  if (inputTokens === undefined && outputTokens === undefined) {
    return "Not recorded";
  }

  return `${inputTokens ?? 0} in / ${outputTokens ?? 0} out`;
}

export function AIProvenanceBadge({ provenance, compact = false }: AIProvenanceBadgeProps) {
  const [open, setOpen] = useState(false);
  const detailsId = useMemo(() => `${provenance.artifactId}-provenance`, [provenance.artifactId]);

  return (
    <div className="ai-provenance">
      <button
        aria-controls={detailsId}
        aria-expanded={open}
        className="ai-provenance-badge"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <Sparkles aria-hidden="true" size={14} />
        <span>{compact ? "AI" : "AI-assisted"}</span>
        <BadgeInfo aria-hidden="true" size={14} />
      </button>
      {open ? (
        <div id={detailsId}>
          <AIProvenanceDetails provenance={provenance} />
        </div>
      ) : null}
    </div>
  );
}

export function AIProvenanceDetails({ provenance }: AIProvenanceDetailsProps) {
  const tools = provenance.tools ?? [];
  const sources = provenance.sources ?? [];

  return (
    <section className="ai-provenance-details" aria-label="AI provenance details">
      <header className="ai-provenance-details-header">
        <Bot aria-hidden="true" size={18} />
        <div>
          <strong>{provenance.providerId}</strong>
          <span>{provenance.model}</span>
        </div>
      </header>

      <dl className="ai-provenance-grid">
        <div>
          <dt>
            <Route aria-hidden="true" size={14} />
            Feature
          </dt>
          <dd>{provenance.feature}</dd>
        </div>
        <div>
          <dt>
            <Clock3 aria-hidden="true" size={14} />
            Created
          </dt>
          <dd>{formatDate(provenance.createdAt)}</dd>
        </div>
        <div>
          <dt>
            <Hash aria-hidden="true" size={14} />
            Prompt hash
          </dt>
          <dd>{provenance.promptHash}</dd>
        </div>
        <div>
          <dt>
            <Database aria-hidden="true" size={14} />
            Usage
          </dt>
          <dd>{formatTokens(provenance.inputTokens, provenance.outputTokens)}</dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>{formatCost(provenance.costUsdMicros)}</dd>
        </div>
        <div>
          <dt>Latency</dt>
          <dd>{provenance.latencyMs === undefined ? "Not recorded" : `${provenance.latencyMs} ms`}</dd>
        </div>
        <div>
          <dt>Actor</dt>
          <dd>{provenance.actorName}</dd>
        </div>
        <div>
          <dt>Classification</dt>
          <dd>{provenance.classification ?? "standard"}</dd>
        </div>
        {provenance.traceId ? (
          <div>
            <dt>Trace</dt>
            <dd>{provenance.traceId}</dd>
          </div>
        ) : null}
      </dl>

      {tools.length > 0 ? (
        <div className="ai-provenance-section">
          <h2>
            <Wrench aria-hidden="true" size={15} />
            Tools
          </h2>
          <ul className="ai-provenance-list">
            {tools.map((tool) => (
              <li key={tool.id}>
                <strong>{tool.name}</strong>
                <span data-status={tool.status}>{tool.status}</span>
                {tool.summary ? <p>{tool.summary}</p> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {sources.length > 0 ? (
        <div className="ai-provenance-section">
          <h2>
            <Database aria-hidden="true" size={15} />
            Sources
          </h2>
          <ul className="ai-provenance-list">
            {sources.map((source) => (
              <li key={source.id}>
                <strong>{source.title}</strong>
                <span>{source.type}</span>
                {source.reference ? <p>{source.reference}</p> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
