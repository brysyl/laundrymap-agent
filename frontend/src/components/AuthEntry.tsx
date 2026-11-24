"use client";
import dynamic from "next/dynamic";
import { Suspense } from "react";

function Skeleton() {
  return (
    <main className="auth-wrap" aria-busy="true">
      <div className="auth-card">
        <div className="skeleton" style={{ height: 28, width: "50%" }} />
        <div className="skeleton" style={{ height: 44 }} />
        <div className="skeleton" style={{ height: 44 }} />
        <div className="skeleton" style={{ height: 44 }} />
      </div>
    </main>
  );
}

const AuthForm = dynamic(() => import("@/components/AuthForm"), { ssr: false, loading: () => <Skeleton /> });

export default function AuthEntry() {
  return <Suspense fallback={<Skeleton />}><AuthForm /></Suspense>;
}
