import { useDebouncedValue } from "@tanstack/react-pacer/debouncer";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search as SearchIcon, Star as StarIcon } from "lucide-react";
import { useState } from "react";
import { peopleDirectoryQueryOptions, type PeopleDirectoryPerson } from "@/features/people/api";
import { personRefFromDirectory } from "@/features/people/person-ref";
import { PersonAvatar } from "./person-chip";
import { PersonHovercard } from "./person-hovercard";
import "./people.css";

const KIND_LABEL: Record<PeopleDirectoryPerson["kind"], string | null> = {
  directory: null,
  personal: "Contact",
  group: "Group",
};

/** Contacts mini panel in the shell's right-hand side panel. */
export function ContactsPanel() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [debouncedQuery] = useDebouncedValue(query.trim(), { wait: 200 });
  const people = useQuery({
    ...peopleDirectoryQueryOptions({ query: debouncedQuery, limit: 50 }),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="contacts-panel">
      <div className="contacts-panel-search">
        <div className="relative">
          <SearchIcon
            size={14}
            aria-hidden="true"
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            className="input [padding-left:30px]"
            placeholder="Search people and groups"
            aria-label="Search contacts"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </div>
      </div>
      {people.isPending ? (
        <p className="contacts-panel-state" role="status">
          Loading contacts…
        </p>
      ) : null}
      {people.isError ? (
        <div className="contacts-panel-state" role="alert">
          <p>Contacts could not be loaded. Check your connection, then try again.</p>
          <button
            type="button"
            className="btn sm mt-2"
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: ["people", "directory"] });
            }}
          >
            Try again
          </button>
        </div>
      ) : null}
      {people.data?.length === 0 ? (
        <p className="contacts-panel-state">
          {debouncedQuery.length > 0
            ? `No people or groups match “${debouncedQuery}”.`
            : "No contacts yet."}
        </p>
      ) : null}
      {people.data === undefined || people.data.length === 0 ? null : (
        <ul className="contacts-panel-list" aria-label="Contacts">
          {people.data.map((person) => (
            <li key={`${person.kind}:${person.id}`}>
              <ContactRow person={person} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ContactRow({ person }: { readonly person: PeopleDirectoryPerson }) {
  const ref = personRefFromDirectory(person);
  const badge = KIND_LABEL[person.kind];
  const detail = person.title ?? person.email;
  return (
    <PersonHovercard person={ref}>
      {(trigger) => (
        <button type="button" className="contacts-panel-row" {...trigger}>
          <PersonAvatar person={ref} size={32} />
          <span className="flex min-w-0 flex-col">
            <span className="flex items-center gap-1 truncate [font-size:var(--text-body-sm)] font-medium">
              {person.displayName}
              {person.favorite ? (
                <>
                  <StarIcon
                    size={12}
                    aria-hidden="true"
                    className="shrink-0 fill-current [color:var(--warning)]"
                  />
                  <span className="sr-only">, favorite</span>
                </>
              ) : null}
            </span>
            {detail === null ? null : (
              <span className="truncate [font-size:var(--text-meta)] text-muted-foreground">
                {detail}
              </span>
            )}
          </span>
          {badge === null ? null : <span className="contacts-panel-badge">{badge}</span>}
        </button>
      )}
    </PersonHovercard>
  );
}
