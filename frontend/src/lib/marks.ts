import { useQuery } from "@tanstack/react-query";

import { api } from "./api";
import type { Day, DayChange } from "./days";
import type { GroupMark } from "./groupResult";

export type MarksResponse = { marks: GroupMark[] };

export const marksRoot = ["marks"] as const;
export const marksKey = (gid: number, from: Day, to: Day) => ["marks", gid, from, to] as const;

/** Every member's marks in [from, to]; refetched on focus and every 60 s while visible (§3.14). */
export function useGroupMarks(gid: number, from: Day, to: Day) {
  return useQuery({
    queryKey: marksKey(gid, from, to),
    queryFn: () =>
      api<MarksResponse>(`/api/groups/${gid}/marks?from=${from}&to=${to}`).then((r) => r.marks),
    refetchInterval: 60_000,
    placeholderData: (previous) => previous,
  });
}

export function putMarks(userId: number, groupId: number, days: DayChange[]) {
  return api<{ previous: DayChange[] }>("/api/marks", {
    method: "PUT",
    body: { user_id: userId, group_id: groupId, days },
  });
}

/** `marks` with `changes` applied for one user: what the server will hold after the write. */
export function applyChanges(
  marks: GroupMark[],
  userId: number,
  changes: DayChange[],
  setByName: string | null,
): GroupMark[] {
  const touched = new Set(changes.map((c) => c.day));
  const kept = marks.filter((m) => !(m.user_id === userId && touched.has(m.day)));
  const added: GroupMark[] = [];
  for (const c of changes) {
    if (c.state !== "free") {
      added.push({
        user_id: userId,
        day: c.day,
        state: c.state,
        note: c.note,
        set_by_name: setByName,
        set_by_former: false,
      });
    }
  }
  return [...kept, ...added];
}
