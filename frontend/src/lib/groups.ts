import { useQuery } from "@tanstack/react-query";

import { api } from "./api";

export type Role = "admin" | "member";
export type Region = "DE-BE" | "DE-BB";
export const REGIONS: Region[] = ["DE-BE", "DE-BB"];

export type GroupSummary = {
  id: number;
  name: string;
  role: Role;
  is_member: boolean;
  member_count: number;
};

export type Member = {
  id: number;
  display_name: string;
  role: Role;
  availability_updated_at: string | null;
  is_instance_admin: boolean;
};

export type Group = {
  id: number;
  name: string;
  regions: Region[];
  role: Role;
  is_member: boolean;
  members: Member[];
};

export type Invite = {
  id: number;
  created_at: string;
  expires_at: string;
  use_count: number;
  created_by_name: string | null;
  url: string | null; // null: created before links were kept; can't be shown again
};

export const groupsKey = ["groups"] as const;
export const groupKey = (gid: number) => ["group", gid] as const;
export const invitesKey = (gid: number) => ["group", gid, "invites"] as const;

export function useGroups() {
  return useQuery({ queryKey: groupsKey, queryFn: () => api<GroupSummary[]>("/api/groups") });
}

export function useGroup(gid: number) {
  // Polled like the marks, so "updated n ago" and membership changes show up (§3.14).
  return useQuery({
    queryKey: groupKey(gid),
    queryFn: () => api<Group>(`/api/groups/${gid}`),
    refetchInterval: 60_000,
  });
}
