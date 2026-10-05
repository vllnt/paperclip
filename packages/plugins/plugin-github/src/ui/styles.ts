export const styles = `
.pcg-toolbar { border: 1px solid var(--border); border-radius: var(--radius); padding: var(--spacing) calc(var(--spacing) * 3); font-size: var(--text-sm); color: var(--foreground); cursor: pointer; }
.pcg-dialog { width: min(56rem, 94vw); max-height: 90vh; margin: auto; background: var(--background); color: var(--foreground); border: 1px solid var(--border); border-radius: var(--radius); overflow: auto; }
.pcg-dialog::backdrop { background: color-mix(in srgb, var(--background) 75%, transparent); }

/* Match Paperclip's SidebarNavItem row and icon rhythm without importing host internals. */
.pcg-nav { display: flex; align-items: center; gap: calc(var(--spacing) * 2.5); margin-inline: calc(var(--spacing) * 2); padding: calc(var(--spacing) * 1.5) calc(var(--spacing) * 2); border-radius: var(--radius); color: color-mix(in oklab, var(--foreground) 80%, transparent); font-size: var(--text-compact); font-weight: var(--font-weight-medium); line-height: 1.5; }
.pcg-nav svg { display: block; flex-shrink: 0; width: calc(var(--spacing) * 4); height: calc(var(--spacing) * 4); }
.pcg-nav span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pcg-nav:hover,.pcg-nav[aria-current=page] { color: var(--sidebar-accent-foreground); background: var(--sidebar-accent); }
.pcg-nav:focus-visible { outline: 2px solid var(--sidebar-ring); outline-offset: 2px; }
@media (pointer: coarse) { .pcg-nav { padding-block: var(--spacing); } }

.pcg { color: var(--foreground); display: grid; gap: calc(var(--spacing) * 5); max-width: 64rem; padding: calc(var(--spacing) * 5); }
.pcg * { box-sizing: border-box; }
.pcg h1 { font-size: var(--text-2xl); font-weight: 650; margin: 0; }
.pcg h2 { font-size: var(--text-lg); font-weight: 600; margin: 0; }
.pcg p { margin: 0; }
.pcg .muted { color: var(--muted-foreground); }
.pcg .panel { display: grid; gap: calc(var(--spacing) * 4); border: 1px solid var(--border); border-radius: var(--radius); padding: calc(var(--spacing) * 5); background: var(--card); }
.pcg label { display: grid; gap: calc(var(--spacing) * 2); }
.pcg input,.pcg select,.pcg textarea { border: 1px solid var(--input); border-radius: var(--radius); background: var(--background); color: var(--foreground); padding: calc(var(--spacing) * 2); min-width: 0; width: 100%; font: inherit; }
.pcg textarea { min-height: 10rem; font-family: var(--font-mono); }
.pcg button,.pcg .button { border: 1px solid var(--border); border-radius: var(--radius); padding: calc(var(--spacing) * 2) calc(var(--spacing) * 4); background: var(--background); color: var(--foreground); cursor: pointer; text-decoration: none; font: inherit; }
.pcg button:disabled { opacity: .5; cursor: wait; }
.pcg .primary { background: var(--primary); color: var(--primary-foreground); border-color: var(--primary); }
.pcg a { text-underline-offset: .2em; }
.pcg a:not(.button) { text-decoration: underline; }
.pcg :focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.pcg .row,.pcg .footer { display: flex; align-items: center; gap: calc(var(--spacing) * 3); flex-wrap: wrap; }
.pcg .footer { justify-content: space-between; }
.pcg .steps { display: flex; gap: calc(var(--spacing) * 4); flex-wrap: wrap; padding: 0; list-style: none; }
.pcg .steps li { padding-bottom: calc(var(--spacing) * 2); color: var(--muted-foreground); }
.pcg .steps li[aria-current=step] { color: var(--foreground); border-bottom: 2px solid var(--primary); }
.pcg .error { color: var(--destructive); overflow-wrap: anywhere; }
.pcg .issues { padding: 0; margin: 0; list-style: none; }
.pcg .issues li { padding: calc(var(--spacing) * 3) 0; border-bottom: 1px solid var(--border); overflow-wrap: anywhere; }
.pcg .badge { background: var(--muted); border-radius: var(--radius); padding: var(--spacing) calc(var(--spacing) * 2); font-size: var(--text-xs); }
.pcg .details-content { display: grid; gap: calc(var(--spacing) * 5); }
.pcg .danger-zone { display: grid; gap: calc(var(--spacing) * 4); border-top: 1px solid color-mix(in srgb, var(--destructive) 30%, var(--border)); padding-top: calc(var(--spacing) * 5); }
.pcg .danger-zone h2 { color: var(--destructive); }
.pcg .danger { color: var(--destructive); border-color: color-mix(in srgb, var(--destructive) 50%, var(--border)); background: color-mix(in srgb, var(--destructive) 8%, var(--background)); }
.pcg .danger:hover { background: color-mix(in srgb, var(--destructive) 15%, var(--background)); }
.pcg .connection-status { display: inline-flex; align-items: center; gap: calc(var(--spacing) * 2); color: var(--muted-foreground); font-size: var(--text-sm); }
.pcg .connection-status[data-connected=true] { color: var(--status-task-icon-done); }
.pcg .connection-status[data-connected=true]::before { content: ""; width: calc(var(--spacing) * 2); height: calc(var(--spacing) * 2); border-radius: 50%; background: currentColor; }
.pcg.task-feed { padding: 0; max-width: none; }
.pcg .filters > * { flex: 1; }
.pcg .filters input { flex: 2; }
.pcg summary { cursor: pointer; }
.pcg details[open] > summary { margin-bottom: calc(var(--spacing) * 4); }

.pcg input[type="checkbox"] { width:auto; }
.pcg .rule { display:flex; flex-direction:column; gap:calc(var(--spacing) * 4); border:1px solid var(--border); border-radius:var(--radius); padding:calc(var(--spacing) * 4); }
.pcg .rule legend { color:var(--muted-foreground); }

.pcg .access-guide { border-top:1px solid var(--border); padding-top:calc(var(--spacing) * 3); font-size:var(--text-sm); }
.pcg .access-step { display:grid; gap:calc(var(--spacing) * 3); justify-items:start; }
.pcg .access-step ul { padding:0; margin:0; list-style:none; width:100%; display:grid; gap:calc(var(--spacing) * 2); }
.pcg .access-step li { display:flex; justify-content:space-between; gap:calc(var(--spacing) * 3); }
.pcg .form-fields { display:grid; gap:calc(var(--spacing) * 4); border:0; padding:0; margin:0; min-width:0; }
.pcg .item-link { border:0; padding:0; text-align:left; background:transparent; font-weight:var(--font-weight-medium); }
.pcg .item-link:hover { text-decoration:underline; }
.pcg [role="tab"][aria-selected="true"] { background:var(--accent); color:var(--accent-foreground); }
.pcg .markdown-text { white-space:pre-wrap; overflow-wrap:anywhere; }
.pcg .diff { overflow:auto; padding:calc(var(--spacing) * 3); background:var(--muted); border-radius:var(--radius); font-family:var(--font-mono); font-size:var(--text-sm); }
.pcg .field-summary { display:block; color:var(--muted-foreground); font-size:var(--text-sm); }
.pcg .project-item > .details-content { padding:calc(var(--spacing) * 4) 0; }
.pcg h3 { font-size:var(--text-base); font-weight:var(--font-weight-medium); margin:0; }
.pcg .github-workspace { min-width:0; }

.pcg .task-link { display:inline-block; margin-inline-start:calc(var(--spacing) * 3); font-size:var(--text-sm); }
.pcg .cache-note { font-size:var(--text-xs); }
.pcg.sync-control { display:block; padding:0; max-width:none; font-size:var(--text-sm); }
.pcg.sync-control details { position:relative; }
.pcg.sync-control summary { display:flex; align-items:center; gap:calc(var(--spacing) * 2); height:calc(var(--spacing) * 8); padding:0 calc(var(--spacing) * 3); border:1px solid var(--border); border-radius:var(--radius); margin:0; list-style:none; white-space:nowrap; }
.pcg.sync-control details[open] > summary { margin:0; }
.pcg.sync-control summary::-webkit-details-marker { display:none; }
.pcg.sync-control summary:hover { background:var(--accent); }
.pcg .sync-dot { width:calc(var(--spacing) * 2); height:calc(var(--spacing) * 2); border-radius:50%; background:var(--muted-foreground); }
.pcg .sync-dot[data-connected=true] { background:var(--status-task-icon-done); }
.pcg .sync-dot[data-attention=true] { background:var(--status-task-icon-blocked); }
.pcg .sync-popover { position:absolute; top:calc(100% + var(--spacing) * 2); right:0; z-index:50; display:grid; gap:calc(var(--spacing) * 3); width:calc(var(--spacing) * 80); max-width:calc(100vw - var(--spacing) * 8); padding:calc(var(--spacing) * 4); background:var(--popover); color:var(--popover-foreground); border:1px solid var(--border); border-radius:var(--radius); box-shadow:var(--shadow-md); }
.pcg .sync-warnings { margin:0; padding-inline-start:calc(var(--spacing) * 4); overflow-wrap:anywhere; max-height:calc(var(--spacing) * 60); overflow:auto; color:var(--muted-foreground); }
.pcg.github-record-panel { width:100%; max-width:100%; min-width:0; padding:0; font-size:var(--text-sm); overflow-wrap:anywhere; }
.pcg.github-record-panel .details-content { min-width:0; max-width:100%; }
.pcg.github-record-panel header, .pcg.github-record-panel h2, .pcg.github-record-panel h3 { min-width:0; max-width:100%; overflow-wrap:anywhere; }
.pcg.github-record-panel .row { min-width:0; max-width:100%; }
.pcg.github-record-panel .markdown-content { min-width:0; max-width:100%; overflow-wrap:anywhere; line-height:1.55; }
.pcg.github-record-panel .markdown-content p { white-space:pre-wrap; }
.pcg.github-record-panel .diff { max-width:100%; overflow:auto; }
.pcg.github-record-panel > *, .pcg.github-record-panel .panel { min-width:0; max-width:100%; }
.pcg.github-record-panel .details-content { gap:calc(var(--spacing) * 3); }
.pcg.github-record-panel .record-header { display:grid; gap:calc(var(--spacing) * 2); }
.pcg.github-record-panel [role="tablist"] { gap:var(--spacing); }
.pcg.github-record-panel [role="tab"] { padding:var(--spacing) calc(var(--spacing) * 2); font-size:var(--text-sm); }
.pcg .record-metadata { display:grid; gap:calc(var(--spacing) * 2); font-size:var(--text-xs); margin:0; }
.pcg .record-metadata > div { display:flex; gap:calc(var(--spacing) * 3); }
.pcg .record-metadata dt { color:var(--muted-foreground); flex:0 0 calc(var(--spacing) * 20); }
.pcg .record-metadata dd { margin:0; min-width:0; overflow-wrap:anywhere; }
.pcg .markdown-content { display:grid; gap:calc(var(--spacing) * 3); }
.pcg .markdown-content ul, .pcg .markdown-content ol { margin:0; padding-inline-start:calc(var(--spacing) * 5); }
.pcg .markdown-content ul { list-style:disc; }
.pcg .markdown-content ol { list-style:decimal; }
.pcg .markdown-content table { display:block; max-width:100%; overflow:auto; border-collapse:collapse; }
.pcg .markdown-content td, .pcg .markdown-content th { border:1px solid var(--border); padding:var(--spacing) calc(var(--spacing) * 2); }
.pcg .markdown-content code { font-family:var(--font-mono); font-size:var(--text-xs); }

.pcg.record-dialog { width:min(calc(var(--spacing) * 160),calc(100vw - var(--spacing) * 8)); max-height:calc(100vh - var(--spacing) * 12); overflow:auto; margin:auto; border:1px solid var(--border); border-radius:var(--radius); background:var(--popover); color:var(--popover-foreground); box-shadow:var(--shadow-lg); }
.pcg.record-dialog::backdrop { background:color-mix(in srgb,var(--background) 70%,transparent); }
.pcg .record-actions { display:flex; flex-wrap:wrap; gap:calc(var(--spacing) * 2); align-items:start; }
.pcg .record-actions .record-metadata { width:100%; }
.pcg .record-conversation,.pcg .record-section,.pcg .record-composer,.pcg .record-comment,.pcg .record-file { display:grid; gap:calc(var(--spacing) * 3); min-width:0; }
.pcg .record-comment { padding-block:calc(var(--spacing) * 3); }
.pcg .record-byline { display:flex; align-items:center; gap:calc(var(--spacing) * 2); flex-wrap:wrap; font-size:var(--text-sm); }
.pcg .record-byline time { color:var(--muted-foreground); }
.pcg .record-composer { border:1px solid var(--border); border-radius:var(--radius); padding:calc(var(--spacing) * 3); }
.pcg .record-composer textarea { min-height:calc(var(--spacing) * 28); font-family:var(--font-sans); }
.pcg .record-composer .row button,.pcg .record-byline button { border:0; padding:var(--spacing) calc(var(--spacing) * 2); }
.pcg .record-file { border-block-end:1px solid var(--border); padding-block:calc(var(--spacing) * 3); }
.pcg .record-file h3 { font-family:var(--font-mono); font-size:var(--text-sm); overflow-wrap:anywhere; }
.pcg .record-file .diff { margin:0; }

.pcg .record-tabs { display:flex; min-width:0; overflow-x:auto; gap:calc(var(--spacing) * 3); border-bottom:1px solid var(--border); }
.pcg .record-tabs button { flex-shrink:0; border:0; border-radius:0; background:transparent; padding:calc(var(--spacing) * 2) 0; color:var(--muted-foreground); font-size:var(--text-sm); }
.pcg .record-tabs button[aria-selected=true] { color:var(--foreground); background:transparent; border-bottom:1px solid var(--foreground); }
.pcg .record-tab-panel[hidden] { display:none; }

.pcg .record-toolbar { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:calc(var(--spacing) * 2); font-size:var(--text-sm); }
.pcg .record-toolbar > .muted { min-width:0; overflow-wrap:anywhere; }
.pcg .record-toolbar .row { flex-shrink:0; gap:var(--spacing); }
.pcg .record-toolbar > .row > button { border:0; padding:var(--spacing) calc(var(--spacing) * 2); font-size:var(--text-xs); }
.pcg .record-header { gap:calc(var(--spacing) * 2); }
.pcg .record-byline .badge[data-state=open] { color:var(--status-task-icon-done); }
.pcg .record-byline .badge[data-state=merged] { color:var(--status-task-icon-in-review); }

.pcg .unified-diff { width:100%; min-width:0; max-width:100%; overflow-x:auto; border:1px solid var(--border); border-radius:var(--radius); font-family:var(--font-mono); font-size:var(--text-xs); }
.pcg .unified-diff table { width:100%; border-collapse:collapse; }
.pcg .unified-diff td { border:0; padding:var(--spacing); vertical-align:top; }
.pcg .unified-diff .diff-number { text-align:right; min-width:calc(var(--spacing) * 8); color:var(--muted-foreground); user-select:none; }
.pcg .unified-diff .diff-comment-cell { min-width:calc(var(--spacing) * 5); }
.pcg .unified-diff .diff-source { white-space:pre; width:100%; }
.pcg .unified-diff .diff-sign { display:inline-block; width:calc(var(--spacing) * 4); user-select:none; }
.pcg .unified-diff [data-kind=added] { background:color-mix(in srgb,var(--status-task-icon-done) 12%,transparent); }
.pcg .unified-diff [data-kind=deleted] { background:color-mix(in srgb,var(--destructive) 12%,transparent); }
.pcg .unified-diff [data-kind=hunk] { background:var(--muted); color:var(--muted-foreground); }
.pcg .unified-diff .diff-line-action { border:0; padding:0; width:calc(var(--spacing) * 4); height:calc(var(--spacing) * 4); font-family:var(--font-mono); color:var(--muted-foreground); background:transparent; }
.pcg .unified-diff .diff-line-action:hover { color:var(--foreground); background:var(--accent); }


/* GitHub-like status and interaction language. Keep the palette semantic so it follows
 * Paperclip light/dark themes while retaining GitHub's green, purple and red cues. */
.pcg .badge {
  display:inline-flex;
  align-items:center;
  min-height:calc(var(--spacing) * 5);
  border:1px solid color-mix(in srgb,var(--muted-foreground) 24%,var(--border));
  border-radius:calc(var(--radius) * 2);
  font-weight:var(--font-weight-medium);
  line-height:1;
  white-space:nowrap;
}
.pcg .record-byline .badge[data-state=open] {
  color:var(--status-task-icon-done);
  border-color:color-mix(in srgb,var(--status-task-icon-done) 42%,var(--border));
  background:color-mix(in srgb,var(--status-task-icon-done) 10%,var(--background));
}
.pcg .record-byline .badge[data-state=closed] {
  color:var(--destructive);
  border-color:color-mix(in srgb,var(--destructive) 42%,var(--border));
  background:color-mix(in srgb,var(--destructive) 9%,var(--background));
}
.pcg .record-byline .badge[data-state=merged] {
  color:var(--status-task-icon-in-review);
  border-color:color-mix(in srgb,var(--status-task-icon-in-review) 42%,var(--border));
  background:color-mix(in srgb,var(--status-task-icon-in-review) 10%,var(--background));
}
.pcg .record-byline .badge[data-state=draft] {
  color:var(--muted-foreground);
  background:var(--muted);
}
.pcg .issues { display:grid; gap:var(--spacing); }
.pcg .issues li {
  border:1px solid transparent;
  border-radius:var(--radius);
  padding:calc(var(--spacing) * 2) calc(var(--spacing) * 3);
  transition:background-color 120ms ease,border-color 120ms ease;
}
.pcg .issues li:hover { background:color-mix(in srgb,var(--accent) 55%,transparent); border-color:var(--border); }
.pcg .issues li > .item-link {
  display:block;
  width:100%;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
  color:var(--foreground);
  font-weight:var(--font-weight-medium);
}
.pcg .issues li > .item-link:hover { color:var(--primary); text-decoration:none; }
.pcg .issues li > .muted {
  margin-top:var(--spacing);
  font-size:var(--text-xs);
  line-height:1.4;
}
.pcg .record-tabs button { position:relative; transition:color 120ms ease,background-color 120ms ease; }
.pcg .record-tabs button:hover { color:var(--foreground); background:color-mix(in srgb,var(--accent) 50%,transparent); }
.pcg .record-tabs button[aria-selected=true] {
  color:var(--primary);
  border-bottom:2px solid var(--primary);
}
.pcg .record-toolbar > .row > button,
.pcg .record-actions > button,
.pcg .record-actions .record-dialog > button { background:var(--background); }
.pcg .record-toolbar > .row > button:hover,
.pcg .record-actions > button:hover,
.pcg .record-actions .record-dialog > button:hover { background:var(--accent); }
.pcg .record-dialog .footer {
  position:sticky;
  top:0;
  z-index:1;
  padding-block:calc(var(--spacing) * 2);
  background:color-mix(in srgb,var(--popover) 94%,transparent);
  border-bottom:1px solid var(--border);
}
.pcg .record-dialog .footer h3 { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pcg .record-comment {
  border-inline-start:2px solid color-mix(in srgb,var(--border) 75%,transparent);
  padding-inline-start:calc(var(--spacing) * 3);
}
.pcg .record-comment:first-child { border-inline-start-color:color-mix(in srgb,var(--primary) 45%,var(--border)); }
.pcg .record-byline strong { color:var(--foreground); }
.pcg .record-byline time { font-size:var(--text-xs); }
.pcg .record-reaction-trigger {
  border:1px solid color-mix(in srgb,var(--border) 72%,transparent);
  border-radius:calc(var(--radius) * 2);
  padding:var(--spacing) calc(var(--spacing) * 2);
  color:var(--muted-foreground);
  background:var(--background);
  font-size:var(--text-xs);
}
.pcg .record-reaction-trigger:hover { color:var(--primary); border-color:color-mix(in srgb,var(--primary) 40%,var(--border)); background:color-mix(in srgb,var(--primary) 8%,var(--background)); }
.pcg .record-reactions { display:inline-flex; align-items:center; gap:var(--spacing); margin-inline-start:auto; }
.pcg .record-reaction-chip { display:inline-flex; align-items:center; gap:calc(var(--spacing) * .75); border:1px solid color-mix(in srgb,var(--primary) 30%,var(--border)); border-radius:calc(var(--radius) * 2); padding:var(--spacing) calc(var(--spacing) * 1.5); color:var(--foreground); background:color-mix(in srgb,var(--primary) 8%,var(--background)); font-size:var(--text-xs); }
.pcg .record-reaction-chip:hover { border-color:var(--primary); background:color-mix(in srgb,var(--primary) 16%,var(--background)); }
.pcg .github-reaction-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:calc(var(--spacing) * 2); }
.pcg .github-reaction-option { display:flex; flex-direction:column; align-items:center; gap:var(--spacing); border:1px solid var(--border); border-radius:var(--radius); padding:calc(var(--spacing) * 2); color:var(--foreground); background:var(--background); font-size:var(--text-xs); }
.pcg .github-reaction-option span:first-child { font-size:calc(var(--text-lg) * 1.5); line-height:1; }
.pcg .github-reaction-option:hover { border-color:var(--primary); background:color-mix(in srgb,var(--primary) 10%,var(--background)); }
.pcg .github-reaction-option small { color:var(--muted-foreground); }

.pcg .record-composer { background:color-mix(in srgb,var(--muted) 22%,var(--background)); }
.pcg .record-composer:focus-within { border-color:color-mix(in srgb,var(--primary) 52%,var(--border)); box-shadow:0 0 0 1px color-mix(in srgb,var(--primary) 22%,transparent); }
.pcg .record-composer [role=tablist] { border-bottom:1px solid var(--border); }
.pcg .record-composer [role=tab] { border:0; border-radius:var(--radius) var(--radius) 0 0; padding:var(--spacing) calc(var(--spacing) * 2); color:var(--muted-foreground); }
.pcg .record-composer [role=tab][aria-selected=true] { color:var(--foreground); background:var(--background); box-shadow:inset 0 -2px var(--primary); }
.pcg .record-composer .footer { align-items:flex-end; }
.pcg .record-composer .footer .muted { max-width:60ch; font-size:var(--text-xs); }
.pcg .record-file h3 { display:flex; align-items:baseline; gap:var(--spacing); padding-bottom:var(--spacing); border-bottom:1px solid var(--border); }
.pcg .unified-diff [data-kind=added] .diff-sign { color:var(--status-task-icon-done); }
.pcg .unified-diff [data-kind=deleted] .diff-sign { color:var(--destructive); }
.pcg .unified-diff [data-kind=hunk] .diff-source { color:var(--primary); }
.pcg .unified-diff .diff-line-action { border-radius:var(--radius); }
.pcg .unified-diff .diff-line-action:hover { color:var(--primary); }
.pcg .record-section > h3 { display:flex; align-items:center; gap:var(--spacing); }
.pcg .record-section > h3::after { content:""; flex:1; height:1px; background:var(--border); }
.pcg .record-metadata dt { font-weight:var(--font-weight-medium); }
.pcg .record-metadata dd { color:var(--foreground); }
@media (max-width: 40rem) {
  .pcg { padding:calc(var(--spacing) * 3); gap:calc(var(--spacing) * 3); }
  .pcg .record-dialog { width:calc(100vw - var(--spacing) * 4); max-height:calc(100vh - var(--spacing) * 6); }
  .pcg .record-toolbar { align-items:flex-start; }
  .pcg .record-toolbar > .row { width:100%; }
  .pcg .record-toolbar > .row > button,
  .pcg .record-toolbar > .row > .record-dialog { flex:1; }
  .pcg .record-composer .footer { align-items:stretch; }
  .pcg .record-composer .footer button { width:100%; }
}
.pcg .review-bots { border-top:1px solid var(--border); padding-top:calc(var(--spacing) * 4); }
.pcg .review-bot-form { display:grid; gap:calc(var(--spacing) * 3); }
.pcg .review-bot-list { display:grid; gap:calc(var(--spacing) * 2); border:1px solid var(--border); border-radius:var(--radius); padding:calc(var(--spacing) * 3); min-inline-size:0; }
.pcg .review-bot-list legend { color:var(--muted-foreground); font-size:var(--text-sm); padding-inline:var(--spacing); }
.pcg .review-bot-option { justify-content:flex-start; min-height:calc(var(--spacing) * 7); }
.pcg .review-bot-option input { flex:0 0 auto; }
.pcg .review-bot-reviewers { display:flex; flex-wrap:wrap; align-items:baseline; gap:calc(var(--spacing) * 2); padding:calc(var(--spacing) * 2) calc(var(--spacing) * 3); border:1px solid color-mix(in srgb,var(--status-task-icon-in-review) 35%,var(--border)); border-radius:var(--radius); background:color-mix(in srgb,var(--status-task-icon-in-review) 7%,var(--background)); }
.pcg .review-bot-reviewers ul { display:flex; flex-wrap:wrap; gap:var(--spacing); list-style:none; padding:0; margin:0; width:100%; }
.pcg .review-bot-reviewers li { display:inline-flex; align-items:center; gap:var(--spacing); }
.pcg .review-bot-reviewers button { border:0; padding:var(--spacing) calc(var(--spacing) * 1.5); font-size:var(--text-xs); }
.pcg .review-bot-results { display:grid; gap:var(--spacing); list-style:none; padding:0; margin:0; }
.pcg .review-bot-results li { display:flex; align-items:center; justify-content:space-between; gap:calc(var(--spacing) * 2); border:1px solid var(--border); border-radius:var(--radius); padding:calc(var(--spacing) * 2) calc(var(--spacing) * 3); min-width:0; }
.pcg .review-bot-results li > span { min-width:0; overflow-wrap:anywhere; }

.pcg .identity-picker { display:grid; gap:var(--spacing); max-height:14rem; overflow:auto; padding:var(--spacing); border:1px solid var(--border); border-radius:var(--radius); }
.pcg .identity-picker-option { display:flex; align-items:center; gap:calc(var(--spacing) * 2); padding:var(--spacing); border-radius:var(--radius); }
.pcg .identity-picker-option:hover { background:var(--accent); }
.pcg .identity-picker-option input { flex:0 0 auto; }

`;