import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { menuShortcutClass } from "@/components/ui/menu-styles";
import { formatLongDate, type CalendarView } from "./date-math";

export const VIEW_LABELS: Readonly<Record<CalendarView, string>> = {
  day: "Day",
  "3day": "3 days",
  week: "Week",
  month: "Month",
  schedule: "Schedule",
};

const VIEW_KEYS: Readonly<Record<CalendarView, string>> = {
  day: "D",
  "3day": "X",
  week: "W",
  month: "M",
  schedule: "A",
};

const PERIOD_NOUN: Readonly<Record<CalendarView, string>> = {
  day: "day",
  "3day": "3 days",
  week: "week",
  month: "month",
  schedule: "30 days",
};

export function CalendarToolbar({
  title,
  view,
  views,
  today,
  showWeekends,
  onToday,
  onShift,
  onViewChange,
  onShowWeekendsChange,
}: {
  readonly title: string;
  readonly view: CalendarView;
  readonly views: readonly CalendarView[];
  readonly today: string;
  readonly showWeekends: boolean;
  readonly onToday: () => void;
  readonly onShift: (direction: -1 | 1) => void;
  readonly onViewChange: (view: CalendarView) => void;
  readonly onShowWeekendsChange: (value: boolean) => void;
}) {
  const noun = PERIOD_NOUN[view];
  return (
    <div className="cal-toolbar">
      <Button variant="outline" size="sm" onClick={onToday} title={`${formatLongDate(today)} (T)`}>
        Today
      </Button>
      <div className="flex">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Previous ${noun}`}
          title={`Previous ${noun} (K)`}
          onClick={() => onShift(-1)}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Next ${noun}`}
          title={`Next ${noun} (J)`}
          onClick={() => onShift(1)}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
      <h2 className="cal-toolbar-title type-h2 font-normal" aria-live="polite">
        {title}
      </h2>
      <div className="ml-auto">
        <Menu>
          <MenuTrigger asChild>
            <Button variant="outline" size="sm" aria-label={`View: ${VIEW_LABELS[view]}`}>
              {VIEW_LABELS[view]}
              <ChevronDown aria-hidden="true" />
            </Button>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuRadioGroup
              value={view}
              onValueChange={(next) => {
                const picked = views.find((candidate) => candidate === next);
                if (picked !== undefined) onViewChange(picked);
              }}
            >
              {views.map((option) => (
                <MenuRadioItem key={option} value={option}>
                  <span className="flex w-full items-center">
                    {VIEW_LABELS[option]}
                    <kbd className={menuShortcutClass}>{VIEW_KEYS[option]}</kbd>
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
            {views.includes("week") ? (
              <>
                <MenuSeparator />
                <MenuCheckboxItem
                  checked={showWeekends}
                  onCheckedChange={(checked) => onShowWeekendsChange(checked)}
                >
                  Show weekends
                </MenuCheckboxItem>
              </>
            ) : null}
          </MenuContent>
        </Menu>
      </div>
    </div>
  );
}
