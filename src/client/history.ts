// Right-hand history drawer: commits for a file, their diffs, view and restore.
import { api, type Commit } from "./api.ts";
import { confirmDialog } from "./dialogs.ts";
import { clear, errorMessage, h, relativeTime, shortSha, toast } from "./util.ts";

export class HistoryPanel {
  readonly el = h("aside", { class: "history", hidden: true });
  private body = h("div", { class: "history-body" });
  private target: { repo: string; path: string; readOnly: boolean } | null = null;
  private selected: Commit | null = null;
  private selectedLatest = false;
  private loadSeq = 0;

  constructor(private onToggle: (open: boolean) => void) {
    this.el.append(
      h("div", { class: "history-head" },
        h("h2", null, "History"),
        h("button", { class: "icon-btn", type: "button", "aria-label": "Close history", onclick: () => this.close() }, "×"),
      ),
      this.body,
    );
  }

  get open() {
    return !this.el.hidden;
  }

  toggle() {
    if (this.open) this.close();
    else this.show();
  }

  show() {
    this.el.hidden = false;
    this.onToggle(true);
    void this.refresh();
  }

  close() {
    this.el.hidden = true;
    this.selected = null;
    this.loadSeq++;
    this.onToggle(false);
  }

  setTarget(t: { repo: string; path: string; readOnly: boolean } | null) {
    const prev = this.target;
    if (!t || !prev || t.repo !== prev.repo || t.path !== prev.path) {
      this.target = t;
      this.loadSeq++;
      this.selected = null;
      this.body.replaceChildren();
      if (this.open) void this.refresh();
      return;
    }
    // Same file: keep the target object so in-flight loads stay valid.
    if (prev.readOnly === t.readOnly) return;
    prev.readOnly = t.readOnly;
    if (this.open && this.selected) void this.showCommit(this.selected, this.selectedLatest);
  }

  private isCurrent(t: { repo: string; path: string }, sha?: string) {
    return this.target === t && (sha === undefined || this.selected?.sha === sha);
  }

  /** A new commit landed for the file. */
  onSaved(repo: string, path: string) {
    if (this.open && !this.selected && this.target?.repo === repo && this.target.path === path) void this.refresh();
  }

  async refresh() {
    const t = this.target;
    if (!t) {
      clear(this.body, h("p", { class: "empty" }, "Open a note to see its history."));
      return;
    }
    const seq = ++this.loadSeq;
    if (!this.body.childElementCount) clear(this.body, h("p", { class: "muted pad" }, "Loading…"));
    try {
      const commits = await api.history(t.repo, t.path, 100);
      if (seq !== this.loadSeq || !this.isCurrent(t)) return;
      this.renderList(commits);
    } catch (err) {
      if (seq !== this.loadSeq || !this.isCurrent(t)) return;
      clear(this.body, h("p", { class: "form-error pad" }, errorMessage(err)));
    }
  }

  private renderList(commits: Commit[]) {
    if (!commits.length) {
      clear(this.body, h("p", { class: "empty" }, "No saved versions yet. Changes are committed after a short pause, or press ⌘S."));
      return;
    }
    clear(this.body, h("ul", { class: "commits" }, commits.map((c, i) =>
      h("li", null,
        h("button", { type: "button", class: "commit", onclick: () => void this.showCommit(c, i === 0) },
          h("span", { class: "commit-msg" }, c.message.split("\n")[0]),
          h("span", { class: "commit-meta" },
            h("span", null, c.authorName),
            h("span", null, "·"),
            h("span", { title: new Date(c.date).toLocaleString() }, relativeTime(c.date)),
            h("code", null, shortSha(c.sha)),
          ),
        ),
      )),
    ));
  }

  private async showCommit(c: Commit, latest: boolean) {
    const t = this.target;
    if (!t) return;
    this.loadSeq++;
    this.selected = c;
    this.selectedLatest = latest;
    const content = h("div", null, h("p", { class: "muted pad" }, "Loading diff…"));
    const viewBtn = h("button", { type: "button", class: "btn btn-small" }, "View");
    const restoreBtn = h("button", { type: "button", class: "btn btn-small btn-primary", disabled: t.readOnly || latest, title: latest ? "This is the latest version" : t.readOnly ? "Read-only" : "" }, "Restore this version");
    let viewing = false;
    let diffEl: HTMLElement | null = null;

    viewBtn.addEventListener("click", async () => {
      viewing = !viewing;
      viewBtn.textContent = viewing ? "Diff" : "View";
      if (!viewing) {
        if (diffEl) clear(content, diffEl);
        return;
      }
      clear(content, h("p", { class: "muted pad" }, "Loading…"));
      try {
        const { content: text } = await api.file(t.repo, t.path, c.sha);
        if (viewing && this.isCurrent(t, c.sha)) clear(content, h("pre", { class: "file-at-ref" }, text));
      } catch (err) {
        if (viewing && this.isCurrent(t, c.sha)) clear(content, h("p", { class: "form-error pad" }, errorMessage(err)));
      }
    });

    restoreBtn.addEventListener("click", async () => {
      const ok = await confirmDialog({ title: "Restore version", message: `Replace the current text with the version from ${shortSha(c.sha)}? Everyone editing will see the change, and it can be undone from history.`, confirm: "Restore" });
      if (!ok) return;
      try {
        await api.restore(t.repo, t.path, c.sha);
        toast(`Restored version ${shortSha(c.sha)}`);
        if (this.isCurrent(t, c.sha)) {
          this.selected = null;
          void this.refresh();
        }
      } catch (err) {
        toast(errorMessage(err), "error");
      }
    });

    clear(this.body,
      h("div", { class: "commit-detail" },
        h("button", { type: "button", class: "link-btn", onclick: () => ((this.selected = null), void this.refresh()) }, "← All versions"),
        h("div", { class: "commit-title" }, c.message.split("\n")[0]),
        h("div", { class: "commit-meta" }, c.authorName, " · ", relativeTime(c.date), " · ", h("code", null, shortSha(c.sha))),
        h("div", { class: "commit-actions" }, viewBtn, restoreBtn),
      ),
      content,
    );
    try {
      const { diff } = await api.diff(t.repo, c.sha, t.path);
      if (!this.isCurrent(t, c.sha)) return;
      diffEl = renderDiff(diff);
      if (!viewing) clear(content, diffEl);
    } catch (err) {
      if (this.isCurrent(t, c.sha) && !viewing) clear(content, h("p", { class: "form-error pad" }, errorMessage(err)));
    }
  }
}

export function renderDiff(diff: string): HTMLElement {
  if (!diff.trim()) return h("p", { class: "muted pad" }, "No changes to this file in this commit.");
  const pre = h("pre", { class: "diff" });
  for (const line of diff.replace(/\n$/, "").split("\n")) {
    let cls = "ctx";
    if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) cls = "meta";
    else if (line.startsWith("@@")) cls = "hunk";
    else if (line.startsWith("+")) cls = "add";
    else if (line.startsWith("-")) cls = "del";
    pre.appendChild(h("span", { class: `dl dl-${cls}` }, line || " "));
  }
  return pre;
}
