<h1 align="center">cctrim</h1>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/LICENSE-MIT-5C9E31?style=for-the-badge" alt="License"></a>
  <a href="https://agentvania.com"><img src="https://img.shields.io/badge/BUILT%20BY-AGENTVANIA-8A2BE2?style=for-the-badge" alt="Built by"></a>
</p>

<p align="center"><b>Find out why Claude Code burns through your usage, and what to change.</b></p>

Tools like [ccusage](https://github.com/ryoppippi/ccusage) tell you how much you used. cctrim tells you why: which sessions ran too long, which subagents ran away, how much context every session starts with, and which hooks are silently truncated. Then it tells you what to fix.

```
npx github:jgalea/cctrim
```

Requires Node 18+. It reads your local transcripts in `~/.claude/projects` and prints a report. Nothing is sent anywhere.

## What it checks

Most Claude Code usage is cache reads. Every turn re-reads the whole conversation so far, so a session sitting at 500k tokens costs ten times as much per turn as one at 50k. cctrim ranks everything by cache reads for that reason.

- Usage by context size per turn. If most of it comes from turns above 300k, your sessions run too long.
- Sessions with 300+ turns, more than two days of activity, or a 250k+ average context.
- Subagents by type: runs, turns, peak context, share of usage and model. Runs past 150 turns or 400k context are flagged as runaways.
- Model mix for main sessions and subagents, and how much subagent work ran on Opus.
- Fixed overhead: the median context a fresh session starts with, plus the size of the CLAUDE.md, rules and memory files you control.
- Hook output over the 10,000-character `additionalContext` cap. Claude Code saves anything bigger to a file and only shows the model a 2KB preview, and nothing warns you.
- Tool results over 100k characters, which stay in context for the rest of the session.

The report ends with concrete recommendations based on what it found.

## Usage per commit

A usage report says what you spent, not whether it shipped anything. `--shipped` adds a section that counts your own commits (by `git config user.email`) in every git repo you ran Claude Code in, then divides usage by them, per repo and overall. It also splits your weeks into heavier and lighter halves by usage and compares commits per week and usage per commit, and shows a rework share: commits whose files another commit changed again within three days, plus reverts. That last one is a rough proxy: generated files and a series of follow-up commits count as rework too. Commits are the unit for now; merged PRs would be a better one.

Worktrees and clones of the same repo are counted once. Projects that aren't git repos are skipped and counted. Both usage and commits start where your transcripts do, and the week comparison needs at least four complete weeks.

## Options

```
--days <n>       Look back n days (default 7)
--project <str>  Only sessions whose project path contains <str>
--top <n>        Rows per table (default 8)
--shipped        Add usage per commit from local git (default window 56 days)
--json           Machine-readable output
--dir <path>     Claude config dir (default $CLAUDE_CONFIG_DIR or ~/.claude)
```

## Example

```
Sessions that ran too long
  project              turns  days  avg ctx  peak  re-read  compacts
  ~/code/api            1900     7     465k  967k   883.6M         5
  ~/code/site            571     1     483k  727k   276.0M         0

Subagents: 54% of usage
  agent type         runs  turns  peak ctx  share  model
  lead-dev             42   3775      722k    12%  claude-opus-5-5
  docs-writer           1    819      966k     5%  claude-opus-5-5

Hook output over the 10,000-character cap
  output starts with             size  sessions  last seen
  # Project Catalog            25.6KB       590  2026-10-15

What to change
  1. 58% of your usage comes from turns with more than 300k tokens in context. ...
```

With `--shipped`:

```
Shipped units: your commits in the repos you used Claude Code in
  412 commits across 9 repos: 4.2M cache-read and 4.4M total tokens per commit
  Skipped 3 non-git project(s), 61.0M cache-read tokens not counted.
  project            commits  cache-read  per commit  total/commit  rework
  ~/code/api             188      910.4M        4.8M          5.0M     31%
  ~/code/site             97      402.7M        4.2M          4.3M     22%

  Heavier vs lighter weeks
  weeks          cache-read/week  commits/week  per commit
  heavier (n=2)          552.0M            63        8.8M
  lighter (n=2)          214.5M            41        5.2M

  Rework: 27% of commits (109 had a file changed again within 3 days, 2 reverts)
```

## Notes

Token counts come straight from the transcripts. File sizes under Fixed overhead are estimated at four characters per token. cctrim doesn't price anything: on a subscription the dollar figure isn't what you pay, and the shares are what tell you where to act. For cost estimates, use ccusage alongside it.

Claude Code deletes transcripts after 30 days by default, so `--days` can't reach further back than that. Raise `cleanupPeriodDays` in `settings.json` to keep more history; `--shipped` reads it to know where your usage data starts. It needs git 2.31 or newer.

## License

MIT
