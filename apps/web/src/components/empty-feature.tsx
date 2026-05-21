import type { LucideIcon } from "lucide-react";

interface EmptyFeatureProps {
  icon: LucideIcon;
  title: string;
  description: string;
  cta: string;
}

export function EmptyFeature({ icon: Icon, title, description, cta }: EmptyFeatureProps) {
  return (
    <section className="feature-empty" aria-labelledby={`${title.toLowerCase()}-title`} role="main">
      <div className="feature-empty-icon">
        <Icon aria-hidden="true" size={22} />
      </div>
      <h1 id={`${title.toLowerCase()}-title`}>{title}</h1>
      <p>{description}</p>
      <button className="primary-action" type="button">
        {cta}
      </button>
    </section>
  );
}
