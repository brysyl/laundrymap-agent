"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { tokenStore } from "@/lib/api";
import { HOME } from "@/components/Shell";
import type { Role } from "@/lib/types";

/** Shows a link to the dashboard when a session exists. Never redirects. */
export default function DashboardLink() {
  const [role, setRole] = useState<Role | null>(null);
  useEffect(() => {
    const u = tokenStore.user();
    if (u && tokenStore.get()) setRole(u.role);
  }, []);
  if (!role) return null;
  return <Link href={HOME[role]} className="btn btn-primary">Open dashboard</Link>;
}
