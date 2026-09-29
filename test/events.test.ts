import { describe, expect, it } from "vitest";
import {
  eventMarkdown,
  matchesEvents,
  normalizeGithubApiEvent,
  normalizeGithubWebhook,
  normalizeGitlabApiEvent,
  normalizeGitlabWebhook,
} from "../shared/events";

const ghRepo = { full_name: "acme/app", html_url: "https://github.com/acme/app" };

describe("GitHub webhooks", () => {
  it("issue opened", () => {
    const e = normalizeGithubWebhook("issues", {
      action: "opened",
      repository: ghRepo,
      sender: { login: "alice" },
      issue: { number: 7, title: "Crash on start", body: "Steps…", html_url: "https://github.com/acme/app/issues/7", labels: [{ name: "bug" }] },
    });
    expect(e).toMatchObject({
      source: "github", type: "issue.opened", action: "opened", repo: "acme/app", author: "alice",
      number: 7, target: "issue", title: "Crash on start", body: "Steps…", labels: ["bug"],
    });
  });

  it("comment on a pull request (issue_comment with pull_request) → merge_request.comment", () => {
    const e = normalizeGithubWebhook("issue_comment", {
      action: "created",
      repository: ghRepo,
      sender: { login: "bob" },
      issue: { number: 12, title: "Add login", pull_request: { url: "x" }, html_url: "https://github.com/acme/app/pull/12" },
      comment: { body: "@sandflow why?", html_url: "https://github.com/acme/app/pull/12#issuecomment-1", user: { login: "bob" } },
    });
    expect(e).toMatchObject({ type: "merge_request.comment", target: "merge_request", number: 12, author: "bob", body: "@sandflow why?" });
  });

  it("comment on an issue, PR opened, review comment, push", () => {
    expect(
      normalizeGithubWebhook("issue_comment", {
        action: "created", repository: ghRepo, sender: { login: "c" },
        issue: { number: 3, title: "t" }, comment: { body: "hi", user: { login: "c" } },
      })?.type,
    ).toBe("issue.comment");
    expect(
      normalizeGithubWebhook("pull_request", {
        action: "opened", repository: ghRepo, sender: { login: "d" },
        pull_request: { number: 5, title: "Feat", body: "desc", head: { ref: "feat" }, base: { ref: "main" }, html_url: "u" },
      }),
    ).toMatchObject({ type: "merge_request.opened", branch: "feat", targetBranch: "main", number: 5 });
    expect(
      normalizeGithubWebhook("pull_request_review_comment", {
        action: "created", repository: ghRepo, sender: { login: "e" },
        pull_request: { number: 5, title: "Feat", head: { ref: "feat" }, base: { ref: "main" } },
        comment: { body: "nit", user: { login: "e" }, html_url: "u" },
      }),
    ).toMatchObject({ type: "merge_request.comment", number: 5, body: "nit", branch: "feat" });
    expect(
      normalizeGithubWebhook("push", { ref: "refs/heads/main", repository: ghRepo, pusher: { name: "f" }, head_commit: { message: "fix" }, compare: "u" }),
    ).toMatchObject({ type: "push", branch: "main", author: "f", body: "fix" });
  });

  it("ignores unsupported events/actions", () => {
    expect(normalizeGithubWebhook("issues", { action: "closed", repository: ghRepo, issue: { number: 1 } })).toBeUndefined();
    expect(normalizeGithubWebhook("star", { action: "created", repository: ghRepo })).toBeUndefined();
    expect(normalizeGithubWebhook("ping", { zen: "x" })).toBeUndefined();
  });
});

describe("GitLab webhooks", () => {
  const project = { path_with_namespace: "grp/app", web_url: "https://gitlab.corp.local/grp/app" };
  it("note on a merge request", () => {
    const e = normalizeGitlabWebhook({
      object_kind: "note",
      user: { username: "ofek" },
      project,
      object_attributes: { note: "@sandflow explain", noteable_type: "MergeRequest", url: "https://gitlab.corp.local/grp/app/-/merge_requests/9#note_1" },
      merge_request: { iid: 9, title: "Refactor", source_branch: "refactor", target_branch: "main" },
    });
    expect(e).toMatchObject({
      source: "gitlab", type: "merge_request.comment", repo: "grp/app", host: "gitlab.corp.local", author: "ofek",
      body: "@sandflow explain", number: 9, target: "merge_request", branch: "refactor", targetBranch: "main", title: "Refactor",
    });
  });
  it("issue opened, note on issue, MR opened, push; ignores updates", () => {
    expect(
      normalizeGitlabWebhook({
        object_kind: "issue", user: { username: "a" }, project,
        object_attributes: { action: "open", iid: 4, title: "Bug", description: "d", url: "u" }, labels: [{ title: "p1" }],
      }),
    ).toMatchObject({ type: "issue.opened", number: 4, labels: ["p1"] });
    expect(
      normalizeGitlabWebhook({
        object_kind: "note", user: { username: "a" }, project,
        object_attributes: { note: "hi", noteable_type: "Issue" }, issue: { iid: 4, title: "Bug" },
      })?.type,
    ).toBe("issue.comment");
    expect(
      normalizeGitlabWebhook({
        object_kind: "merge_request", user: { username: "a" }, project,
        object_attributes: { action: "open", iid: 9, title: "MR", source_branch: "x", target_branch: "main", url: "u" },
      })?.type,
    ).toBe("merge_request.opened");
    expect(
      normalizeGitlabWebhook({ object_kind: "push", user_username: "a", ref: "refs/heads/dev", project, commits: [{ message: "m" }] }),
    ).toMatchObject({ type: "push", branch: "dev", author: "a" });
    expect(
      normalizeGitlabWebhook({ object_kind: "merge_request", project, object_attributes: { action: "update", iid: 9 } }),
    ).toBeUndefined();
  });
});

describe("polled API events", () => {
  it("GitHub events API items reuse the webhook shapes", () => {
    const e = normalizeGithubApiEvent({
      id: "123",
      type: "IssueCommentEvent",
      actor: { login: "bob" },
      repo: { name: "acme/app" },
      payload: { action: "created", issue: { number: 12, title: "t", pull_request: {} }, comment: { body: "q?", user: { login: "bob" } } },
    });
    expect(e).toMatchObject({ source: "github", type: "merge_request.comment", repo: "acme/app", author: "bob", number: 12 });
  });
  it("GitLab events API: comment on MR and opened issue", () => {
    const note = normalizeGitlabApiEvent(
      {
        id: 99, action_name: "commented on", target_type: "Note", author: { username: "ofek" },
        note: { body: "@sandflow hi", noteable_type: "MergeRequest", noteable_iid: 9 },
      },
      "grp/app",
      "gitlab.corp.local",
    );
    expect(note).toMatchObject({ source: "gitlab", type: "merge_request.comment", number: 9, author: "ofek", body: "@sandflow hi", host: "gitlab.corp.local" });
    expect(
      normalizeGitlabApiEvent({ id: 1, action_name: "opened", target_type: "Issue", target_iid: 3, target_title: "Bug", author: { username: "a" } }, "grp/app"),
    ).toMatchObject({ type: "issue.opened", number: 3, title: "Bug" });
    expect(normalizeGitlabApiEvent({ id: 2, action_name: "closed", target_type: "Issue" }, "grp/app")).toBeUndefined();
  });
});

describe("helpers", () => {
  it("filters by configured event types (empty = all)", () => {
    const e = { source: "github" as const, type: "issue.opened", firedAt: 0 };
    expect(matchesEvents(e, [])).toBe(true);
    expect(matchesEvents(e, undefined)).toBe(true);
    expect(matchesEvents(e, ["issue.opened", "push"])).toBe(true);
    expect(matchesEvents(e, ["merge_request.comment"])).toBe(false);
  });
  it("renders a readable artifact", () => {
    const md = eventMarkdown({
      source: "gitlab", type: "merge_request.comment", repo: "grp/app", author: "ofek", number: 9, title: "Refactor",
      body: "@sandflow explain", url: "u", firedAt: 0,
    });
    expect(md).toContain("# GitLab: merge_request.comment");
    expect(md).toContain("!9 Refactor");
    expect(md).toContain("@sandflow explain");
    expect(md).toContain("Author: ofek");
  });
});
