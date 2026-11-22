// Group events (spec §3.9): data hooks and the bar layout of the month grids.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "./api";
import { compareDays, type Day } from "./days";
import type { GroupEvent } from "./groupResult";

export type Event = GroupEvent & {
  group_id: number;
  time_place: string | null;
  note: string | null;
  created_by_name: string | null; // null: the creator deleted their account ("former member")
  updated_by_name: string | null;
  created_at: string;
  updated_at: string;
};
export type EventInput = {
  title: string;
  start_day: Day;
  end_day: Day;
  time_place: string | null;
  note: string | null;
};

export const EVENT_MAX_DAYS = 31;

export const eventsKey = (gid: number, from: Day, to: Day) => ["events", gid, from, to] as const;

/** Events overlapping [from, to]; refetched on focus and every 60 s like the marks (§3.14). */
export function useGroupEvents(gid: number, from: Day, to: Day) {
  return useQuery({
    queryKey: eventsKey(gid, from, to),
    queryFn: () =>
      api<{ events: Event[] }>(`/api/groups/${gid}/events?from=${from}&to=${to}`).then((r) => r.events),
    refetchInterval: 60_000,
    placeholderData: (previous) => previous,
  });
}

export function useEventMutations(gid: number) {
  const queryClient = useQueryClient();
  const onSuccess = () => queryClient.invalidateQueries({ queryKey: ["events", gid] });
  const base = `/api/groups/${gid}/events`;
  return {
    create: useMutation({
      mutationFn: (input: EventInput) => api<Event>(base, { method: "POST", body: input }),
      onSuccess,
    }),
    update: useMutation({
      mutationFn: ({ id, input }: { id: number; input: EventInput }) =>
        api<Event>(`${base}/${id}`, { method: "PATCH", body: input }),
      onSuccess,
    }),
    remove: useMutation({
      mutationFn: (id: number) => api(`${base}/${id}`, { method: "DELETE" }),
      onSuccess,
    }),
  };
}

/** One bar piece inside a row of days: columns [col, col + span), stacked in `lane`. */
export type Segment<E extends GroupEvent = GroupEvent> = {
  event: E;
  col: number;
  span: number;
  lane: number;
  /** The event starts / ends inside this row (round the bar's end there). */
  starts: boolean;
  ends: boolean;
};

/**
 * Cuts events into per-row segments: a Calendar week (null = padding outside the month) or
 * any row of days. Within a row, overlapping events get separate lanes, earliest/longest first.
 */
export function rowSegments<E extends GroupEvent>(rows: readonly (readonly (Day | null)[])[], events: readonly E[]): Segment<E>[][] {
  const ordered = [...events].sort(
    (a, b) => compareDays(a.start_day, b.start_day) || compareDays(b.end_day, a.end_day) || a.id - b.id,
  );
  return rows.map((row) => {
    const out: Segment<E>[] = [];
    const laneEnds: number[] = []; // last column taken per lane
    for (const event of ordered) {
      let first = -1;
      let last = -1;
      row.forEach((day, i) => {
        if (day !== null && compareDays(event.start_day, day) <= 0 && compareDays(day, event.end_day) <= 0) {
          if (first < 0) first = i;
          last = i;
        }
      });
      if (first < 0) continue;
      let lane = laneEnds.findIndex((end) => end < first);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = last;
      out.push({
        event,
        col: first,
        span: last - first + 1,
        lane,
        starts: row[first] === event.start_day,
        ends: row[last] === event.end_day,
      });
    }
    return out;
  });
}
