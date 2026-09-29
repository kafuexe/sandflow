// Normalises GitHub / GitLab webhook payloads and polled API events into one TriggerEvent shape.

import type { GitEventType, TriggerEvent, TriggerType } from "./types";

// Payloads are external JSON — read them defensively.
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const GIT_EVENTS: { type: GitEventType; label: string }[] = [
  { type: "issue.opened", label: "Issue opened" },
  { type: "issue.comment", label: "Comment on an issue" },
  { type: "merge_request.opened", label: "MR / PR opened" },
  { type: "merge_request.comment", label: "Comment on an MR / PR" },
  { type: "push", label: "Push" },
];

const hostOf = (url: unknown) => {
  try {
    return typeof url === "string" ? new URL(url).hostname : undefined;
  } catch {
    return undefined;
  }
};
const branchOf = (ref: unknown) =>
  typeof ref === "string" && ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined;
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);
const text = (v: unknown) => (typeof v === "string" ? v : undefined);

function make(source: TriggerType, type: GitEventType, fields: Partial<TriggerEvent>, raw: unknown): TriggerEvent {
  const e: TriggerEvent = { source, type, firedAt: Date.now(), ...fields, raw };
  for (const k of Object.keys(e) as (keyof TriggerEvent)[]) if (e[k] === undefined) delete e[k];
  return e;
}

// ---------- GitHub ----------

/** `event` = the X-GitHub-Event header. Returns undefined for events Sandflow doesn't handle. */
export function normalizeGithubWebhook(event: string, p: J): TriggerEvent | undefined {
  if (!p || typeof p !== "object") return undefined;
  const repo = text(p.repository?.full_name);
  const ghHost = hostOf(p.repository?.html_url);
  const host = ghHost && ghHost !== "github.com" ? ghHost : undefined;
  const base = { repo, host, action: text(p.action) };
  const labels = Array.isArray(p.issue?.labels ?? p.pull_request?.labels)
    ? (p.issue?.labels ?? p.pull_request?.labels).map((l: J) => text(l?.name)).filter(Boolean)
    : undefined;

  switch (event) {
    case "issues":
      if (p.action !== "opened") return undefined;
      return make("github", "issue.opened", {
        ...base, author: text(p.issue?.user?.login ?? p.sender?.login), number: num(p.issue?.number), target: "issue",
        title: text(p.issue?.title), body: text(p.issue?.body), url: text(p.issue?.html_url), labels,
      }, p);
    case "issue_comment": {
      if (p.action !== "created") return undefined;
      const onPr = !!p.issue?.pull_request;
      return make("github", onPr ? "merge_request.comment" : "issue.comment", {
        ...base, author: text(p.comment?.user?.login ?? p.sender?.login), number: num(p.issue?.number),
        target: onPr ? "merge_request" : "issue", title: text(p.issue?.title), body: text(p.comment?.body),
        url: text(p.comment?.html_url ?? p.issue?.html_url), labels,
      }, p);
    }
    case "pull_request":
      if (p.action !== "opened") return undefined;
      return make("github", "merge_request.opened", {
        ...base, author: text(p.pull_request?.user?.login ?? p.sender?.login), number: num(p.pull_request?.number),
        target: "merge_request", title: text(p.pull_request?.title), body: text(p.pull_request?.body),
        url: text(p.pull_request?.html_url), branch: text(p.pull_request?.head?.ref), targetBranch: text(p.pull_request?.base?.ref), labels,
      }, p);
    case "pull_request_review_comment":
      if (p.action !== "created") return undefined;
      return make("github", "merge_request.comment", {
        ...base, author: text(p.comment?.user?.login ?? p.sender?.login), number: num(p.pull_request?.number),
        target: "merge_request", title: text(p.pull_request?.title), body: text(p.comment?.body),
        url: text(p.comment?.html_url), branch: text(p.pull_request?.head?.ref), targetBranch: text(p.pull_request?.base?.ref),
      }, p);
    case "push": {
      const branch = branchOf(p.ref);
      if (!branch) return undefined; // tags etc.
      const commits: J[] = Array.isArray(p.commits) ? p.commits : [];
      return make("github", "push", {
        ...base, action: undefined, author: text(p.pusher?.name ?? p.sender?.login), branch,
        body: text(p.head_commit?.message ?? commits.at(-1)?.message), url: text(p.compare),
      }, p);
    }
    default:
      return undefined;
  }
}

const GITHUB_API_EVENT: Record<string, string> = {
  IssuesEvent: "issues",
  IssueCommentEvent: "issue_comment",
  PullRequestEvent: "pull_request",
  PullRequestReviewCommentEvent: "pull_request_review_comment",
  PushEvent: "push",
};

/** An item from `GET /repos/{owner}/{repo}/events` (payloads mirror the webhooks). */
export function normalizeGithubApiEvent(item: J, host?: string): TriggerEvent | undefined {
  const event = GITHUB_API_EVENT[item?.type];
  if (!event) return undefined;
  const p: J = {
    ...item.payload,
    repository: { full_name: item.repo?.name, html_url: host ? `https://${host}/${item.repo?.name}` : undefined },
    sender: { login: item.actor?.login },
    pusher: item.payload?.pusher ?? { name: item.actor?.login },
  };
  return normalizeGithubWebhook(event, p);
}

// ---------- GitLab ----------

/** A GitLab webhook body (the `object_kind` field identifies the event). */
export function normalizeGitlabWebhook(p: J): TriggerEvent | undefined {
  if (!p || typeof p !== "object") return undefined;
  const a: J = p.object_attributes ?? {};
  const base = {
    repo: text(p.project?.path_with_namespace),
    host: hostOf(p.project?.web_url),
    author: text(p.user?.username ?? p.user_username),
  };
  const labels = Array.isArray(p.labels)
    ? p.labels.map((l: J) => text(l?.title)).filter((x: string | undefined): x is string => !!x)
    : undefined;

  switch (p.object_kind) {
    case "issue":
      if (a.action !== "open") return undefined;
      return make("gitlab", "issue.opened", {
        ...base, action: "open", number: num(a.iid), target: "issue", title: text(a.title), body: text(a.description), url: text(a.url), labels,
      }, p);
    case "merge_request":
      if (a.action !== "open") return undefined;
      return make("gitlab", "merge_request.opened", {
        ...base, action: "open", number: num(a.iid), target: "merge_request", title: text(a.title), body: text(a.description),
        url: text(a.url), branch: text(a.source_branch), targetBranch: text(a.target_branch), labels,
      }, p);
    case "note": {
      if (a.noteable_type === "MergeRequest") {
        const mr: J = p.merge_request ?? {};
        return make("gitlab", "merge_request.comment", {
          ...base, action: "comment", number: num(mr.iid), target: "merge_request", title: text(mr.title), body: text(a.note),
          url: text(a.url), branch: text(mr.source_branch), targetBranch: text(mr.target_branch),
        }, p);
      }
      if (a.noteable_type === "Issue") {
        const issue: J = p.issue ?? {};
        return make("gitlab", "issue.comment", {
          ...base, action: "comment", number: num(issue.iid), target: "issue", title: text(issue.title), body: text(a.note), url: text(a.url),
        }, p);
      }
      return undefined;
    }
    case "push": {
      const branch = branchOf(p.ref);
      if (!branch) return undefined;
      const commits: J[] = Array.isArray(p.commits) ? p.commits : [];
      return make("gitlab", "push", { ...base, branch, body: text(commits.at(-1)?.message), url: text(p.project?.web_url) }, p);
    }
    default:
      return undefined;
  }
}

/** An item from `GET /projects/:id/events`. */
export function normalizeGitlabApiEvent(item: J, project: string, host?: string): TriggerEvent | undefined {
  if (!item || typeof item !== "object") return undefined;
  const base = { repo: project, host, author: text(item.author?.username ?? item.author_username) };
  const action = String(item.action_name ?? "");
  if (action === "opened" && (item.target_type === "Issue" || item.target_type === "MergeRequest")) {
    const mr = item.target_type === "MergeRequest";
    return make("gitlab", mr ? "merge_request.opened" : "issue.opened", {
      ...base, action: "open", number: num(item.target_iid), target: mr ? "merge_request" : "issue", title: text(item.target_title),
    }, item);
  }
  if (action === "commented on" && item.note) {
    const mr = item.note.noteable_type === "MergeRequest";
    if (!mr && item.note.noteable_type !== "Issue") return undefined;
    return make("gitlab", mr ? "merge_request.comment" : "issue.comment", {
      ...base, action: "comment", number: num(item.note.noteable_iid), target: mr ? "merge_request" : "issue",
      title: text(item.target_title), body: text(item.note.body),
    }, item);
  }
  if (action.startsWith("pushed") && item.push_data) {
    return make("gitlab", "push", { ...base, branch: text(item.push_data.ref), body: text(item.push_data.commit_title) }, item);
  }
  return undefined;
}

// ---------- helpers ----------

export function matchesEvents(e: TriggerEvent, events: GitEventType[] | undefined): boolean {
  return !events?.length || events.includes(e.type as GitEventType);
}

const SOURCE_NAME: Record<TriggerType, string> = { manual: "Manual", schedule: "Schedule", github: "GitHub", gitlab: "GitLab" };

/** Human/agent-readable summary, used as the trigger block's output artifact. */
export function eventMarkdown(e: TriggerEvent): string {
  const lines = [`# ${SOURCE_NAME[e.source]}: ${e.type}`, ""];
  if (e.repo) lines.push(`Repository: ${e.repo}${e.host ? ` (${e.host})` : ""}`);
  if (e.number !== undefined) {
    const isMr = e.target === "merge_request" || e.type.startsWith("merge_request");
    const ref = e.source === "gitlab" && isMr ? `!${e.number}` : `#${e.number}`;
    lines.push(`${ref} ${e.title ?? ""}`.trim());
  } else if (e.title) lines.push(e.title);
  if (e.author) lines.push(`Author: ${e.author}`);
  if (e.branch) lines.push(`Branch: ${e.branch}${e.targetBranch ? ` → ${e.targetBranch}` : ""}`);
  if (e.labels?.length) lines.push(`Labels: ${e.labels.join(", ")}`);
  if (e.url) lines.push(`URL: ${e.url}`);
  lines.push(`Time: ${new Date(e.firedAt).toISOString()}`);
  if (e.body?.trim()) lines.push("", e.body.trim());
  return lines.join("\n");
}
