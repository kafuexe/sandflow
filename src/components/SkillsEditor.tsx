import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { ExternalLink, FileText, FolderUp, Github, Loader2, Lock, Plus, Trash2, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { skillKey } from "../../shared/skills";
import type { SkillRef } from "../../shared/types";

const MAX_FILE_BYTES = 1024 * 1024;

/** Frontmatter `name:` of a SKILL.md, if any. */
function skillNameFrom(md: string): string | undefined {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)?.[1];
  const name = fm && /^name:\s*["']?([\w.-]+)["']?\s*$/m.exec(fm)?.[1];
  return name || undefined;
}

/** Turn picked files (a folder, or loose files) into `{ name, files }` for upload. */
async function readPicked(list: File[], fromFolder: boolean) {
  const picked = list.filter((f) => f.size <= MAX_FILE_BYTES);
  const rel = (f: File) => {
    if (!fromFolder) return f.name;
    const parts = f.webkitRelativePath.split("/");
    return parts.slice(1).join("/"); // drop the chosen folder's own name
  };
  const files = await Promise.all(
    picked
      .map((f) => ({ f, path: rel(f) }))
      .filter(({ path }) => path && !path.split("/").some((seg) => seg.startsWith(".")))
      .map(async ({ f, path }) => ({ path, content: await f.text() })),
  );
  const skillMd = files.find((f) => f.path === "SKILL.md" || (!fromFolder && /\.md$/i.test(f.path)));
  if (!skillMd) throw new Error(fromFolder ? "The folder needs a SKILL.md at its top level" : "Pick a SKILL.md file");
  if (!fromFolder && skillMd.path !== "SKILL.md") skillMd.path = "SKILL.md"; // a single markdown file becomes the skill
  const folderName = fromFolder ? list[0]?.webkitRelativePath.split("/")[0] : undefined;
  const name = skillNameFrom(skillMd.content) ?? folderName?.replace(/[^\w.-]/g, "-") ?? picked[0].name.replace(/\.md$/i, "");
  return { name, files };
}

function SkillLine({ s, locked, onRemove }: { s: SkillRef; locked?: boolean; onRemove?: () => void }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      {locked ? <Lock className="size-3 shrink-0 text-muted-foreground" /> : null}
      <span className={locked ? "text-muted-foreground" : "font-medium"}>{s.name}</span>
      {s.file ? (
        <Badge variant="secondary" className="px-1 py-0 text-[10px]">
          <FileText /> {s.file.store === "bundled" ? "bundled" : "uploaded"}
        </Badge>
      ) : (
        <Badge variant="outline" className="px-1 py-0 text-[10px]">
          <Github /> {s.source}
        </Badge>
      )}
      {s.url && (
        <a href={s.url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground">
          <ExternalLink className="size-3" />
        </a>
      )}
      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={s.why}>
        {s.why}
      </span>
      {onRemove && (
        <Button size="icon" variant="ghost" className="size-6" onClick={onRemove} title="Remove">
          <Trash2 className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

export function SkillsEditor({
  inherited,
  own,
  onChange,
}: {
  inherited: SkillRef[];
  own: SkillRef[];
  onChange: (skills: SkillRef[] | undefined) => void;
}) {
  const [available, setAvailable] = useState<SkillRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const refresh = () => void api.listSkills().then(setAvailable, () => {});
  useEffect(refresh, []);

  const inheritedKeys = new Set(inherited.map(skillKey));
  const present = new Set([...inherited, ...own].map(skillKey));
  const set = (skills: SkillRef[]) => onChange(skills.length ? skills : undefined);
  const add = (s: SkillRef) => !present.has(skillKey(s)) && set([...own, s]);
  const update = (i: number, patch: Partial<SkillRef>) => set(own.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  async function upload(e: ChangeEvent<HTMLInputElement>, fromFolder: boolean) {
    // Copy first: the FileList is live and resetting the input (so the same file can be re-picked) empties it.
    const list = [...(e.target.files ?? [])];
    e.target.value = "";
    if (!list.length) return;
    setBusy(true);
    setError(undefined);
    try {
      const { name, files } = await readPicked(list, fromFolder);
      const ref = await api.uploadSkill(name, files);
      set([...own.filter((s) => skillKey(s) !== skillKey(ref)), ref]);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const bundled = available.filter((s) => s.file?.store === "bundled" && !present.has(skillKey(s)));
  const uploaded = available.filter((s) => s.file?.store === "user" && !present.has(skillKey(s)));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label className="text-xs">Skills (installed into the sandbox before the block runs)</Label>
        <div className="flex flex-wrap gap-2">
          <Select
            value=""
            onValueChange={(v) => {
              const s = available.find((x) => skillKey(x) === v);
              if (s) add(s);
            }}
          >
            <SelectTrigger size="sm">
              <SelectValue placeholder="Add skill" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Bundled with Sandflow</SelectLabel>
                {bundled.map((s) => (
                  <SelectItem key={skillKey(s)} value={skillKey(s)}>
                    {s.name} <span className="text-muted-foreground">({s.source ?? "bundled"})</span>
                  </SelectItem>
                ))}
              </SelectGroup>
              {uploaded.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Uploaded</SelectLabel>
                  {uploaded.map((s) => (
                    <SelectItem key={skillKey(s)} value={skillKey(s)}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => fileInput.current?.click()} title="Upload a single SKILL.md">
            {busy ? <Loader2 className="animate-spin" /> : <Upload />} From file
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => folderInput.current?.click()} title="Upload a skill folder (SKILL.md + any extra files)">
            <FolderUp /> From folder
          </Button>
          <Button size="sm" variant="outline" onClick={() => set([...own, { name: "", source: "" }])} title="Skill from a GitHub repo, installed with npx skills add">
            <Plus /> GitHub
          </Button>
          <input ref={fileInput} type="file" accept=".md,text/markdown" hidden onChange={(e) => void upload(e, false)} />
          <input
            ref={folderInput}
            type="file"
            hidden
            multiple
            {...({ webkitdirectory: "" } as Record<string, string>)}
            onChange={(e) => void upload(e, true)}
          />
        </div>
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}
      {inherited.map((s) => (
        <SkillLine key={skillKey(s)} s={s} locked />
      ))}
      {own.map((s, i) => {
        if (inheritedKeys.has(skillKey(s))) return null;
        const remove = () => set(own.filter((_, j) => j !== i));
        if (s.file) return <SkillLine key={skillKey(s)} s={s} onRemove={remove} />;
        return (
          <div key={i} className="grid grid-cols-[1fr_1fr_1.4fr_1.4fr_auto] gap-1.5">
            <Input className="h-7 text-xs" placeholder="name" value={s.name} onChange={(e) => update(i, { name: e.target.value })} />
            <Input className="h-7 text-xs" placeholder="owner/repo" value={s.source ?? ""} onChange={(e) => update(i, { source: e.target.value })} />
            <Input className="h-7 text-xs" placeholder="url" value={s.url ?? ""} onChange={(e) => update(i, { url: e.target.value || undefined })} />
            <Input className="h-7 text-xs" placeholder="why" value={s.why ?? ""} onChange={(e) => update(i, { why: e.target.value || undefined })} />
            <Button size="icon" variant="ghost" className="size-7" onClick={remove}>
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        );
      })}
      {inherited.length + own.length === 0 && <div className="text-xs text-muted-foreground">No skills.</div>}
      <p className="text-[11px] text-muted-foreground">
        File skills are copied to <code>~/.claude/skills/</code> in the sandbox (Claude Code agents). GitHub skills are installed
        with <code>npx skills add</code>.
      </p>
    </div>
  );
}
