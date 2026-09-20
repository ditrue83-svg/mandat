"use client";
import { PageLoadError } from "@/components/page-states";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return <PageLoadError reset={reset} />;
}
