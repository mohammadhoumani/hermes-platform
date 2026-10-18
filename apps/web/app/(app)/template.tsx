import { FadeIn } from "@/components/motion";

/** A template (not a layout) is created again on every navigation, so the page fades in each time. */
export default function Template({ children }: { children: React.ReactNode }) {
  return <FadeIn data-testid="page-transition">{children}</FadeIn>;
}
