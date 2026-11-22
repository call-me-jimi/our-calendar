import { useState, type FormEvent } from "react";

import { useI18n } from "../i18n/I18n";
import { ApiError } from "../lib/api";
import { compareDays, daysBetween, isDay, type Day } from "../lib/days";
import { EVENT_MAX_DAYS, useEventMutations, type Event, type EventInput } from "../lib/events";
import { ConfirmButton } from "./ConfirmButton";
import { Sheet } from "./Sheet";

/** Edit an existing event, or create one for a prefilled range. */
export type EventDraft = { event: Event } | { start: Day; end: Day };

/** Create, edit or delete a group event (spec §3.9); any member may. */
export function EventDialog({
  groupId,
  draft,
  onClose,
}: {
  groupId: number;
  draft: EventDraft;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const existing = "event" in draft ? draft.event : null;
  const [title, setTitle] = useState(existing?.title ?? "");
  const [start, setStart] = useState(existing?.start_day ?? ("start" in draft ? draft.start : ""));
  const [end, setEnd] = useState(existing?.end_day ?? ("end" in draft ? draft.end : ""));
  const [timePlace, setTimePlace] = useState(existing?.time_place ?? "");
  const [note, setNote] = useState(existing?.note ?? "");
  const { create, update, remove } = useEventMutations(groupId);

  const datesOk = isDay(start) && isDay(end);
  const endBeforeStart = datesOk && compareDays(end, start) < 0;
  const tooLong = datesOk && !endBeforeStart && daysBetween(start, end) + 1 > EVENT_MAX_DAYS;
  const valid = title.trim().length > 0 && datesOk && !endBeforeStart && !tooLong;
  const busy = create.isPending || update.isPending || remove.isPending;
  const error = create.error ?? update.error ?? remove.error;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    const input: EventInput = {
      title: title.trim(),
      start_day: start,
      end_day: end,
      time_place: timePlace.trim() || null,
      note: note.trim() || null,
    };
    if (existing) update.mutate({ id: existing.id, input }, { onSuccess: onClose });
    else create.mutate(input, { onSuccess: onClose });
  }

  const heading = existing ? t("event.edit") : t("event.new");
  const who = (name: string | null) => name ?? t("event.formerMember");

  return (
    <Sheet title={heading} onClose={onClose}>
      <form className="stack event-form" onSubmit={submit}>
        <label>
          {t("event.title")}
          <input required autoFocus maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="copy-row">
          <label>
            {t("event.start")}
            <input
              type="date"
              required
              value={start}
              onChange={(e) => {
                // Moving the start past the end drags the end along (a one-day event stays one day).
                if (isDay(e.target.value) && isDay(end) && compareDays(e.target.value, end) > 0) setEnd(e.target.value);
                setStart(e.target.value);
              }}
            />
          </label>
          <label>
            {t("event.end")}
            <input type="date" required min={start || undefined} value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
        </div>
        {endBeforeStart && <p className="error">{t("event.endBeforeStart")}</p>}
        {tooLong && <p className="error">{t("event.tooLong")}</p>}
        <label>
          {t("event.timePlace")}
          <input
            maxLength={120}
            value={timePlace}
            placeholder={t("event.timePlacePlaceholder")}
            onChange={(e) => setTimePlace(e.target.value)}
          />
        </label>
        <label>
          {t("event.note")}
          <textarea maxLength={500} rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {existing && (
          <p className="muted small">
            {t("event.createdBy", { name: who(existing.created_by_name) })}
            {existing.updated_at !== existing.created_at &&
              ` · ${t("event.updatedBy", { name: who(existing.updated_by_name) })}`}
          </p>
        )}
        <div className="row-actions">
          <button type="submit" disabled={!valid || busy}>
            {t("common.save")}
          </button>
          {existing && (
            <ConfirmButton
              label={t("event.delete")}
              question={t("event.deleteConfirm")}
              onConfirm={() => remove.mutate(existing.id, { onSuccess: onClose })}
              disabled={busy}
            />
          )}
        </div>
        {error && (
          <p className="error" role="alert">
            {error instanceof ApiError && error.status === 422 ? t("event.invalid") : t("error.generic")}
          </p>
        )}
      </form>
    </Sheet>
  );
}
