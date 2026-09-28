import {
  Bot,
  Box,
  Code,
  FileText,
  Flag,
  GitBranch,
  GitPullRequest,
  Hammer,
  ListChecks,
  Rocket,
  SearchCheck,
  ShieldCheck,
  Split,
  Terminal,
  TestTube,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export const ICONS: Record<string, LucideIcon> = {
  box: Box,
  bot: Bot,
  flag: Flag,
  "git-branch": GitBranch,
  "git-pull-request": GitPullRequest,
  "list-checks": ListChecks,
  hammer: Hammer,
  "search-check": SearchCheck,
  wrench: Wrench,
  split: Split,
  terminal: Terminal,
  code: Code,
  "file-text": FileText,
  rocket: Rocket,
  "shield-check": ShieldCheck,
  "test-tube": TestTube,
};

export function BlockIcon({ name, className }: { name: string; className?: string }) {
  const Icon = ICONS[name] ?? Box;
  return <Icon className={className} />;
}
