# Prompt Enhancer

A Claude Code mod that helps you say what you mean before a prompt is sent.

Prompt Enhancer reads your rough prompt and, only when it would help, asks up to three quick multiple-choice questions. It then rewrites the prompt using your words and your answers, shows the original and the rewrite side by side, and waits. Nothing is sent until you press **Run it**.

```
PROMPT ENHANCER
━━━━━━━━━━━━━━━────────────────────────────────────────
✓ Your prompt  ─  ✓ Questions  ─  ✓ Rewrite  ─  4 Review

Questions answered 2 of 2  ·  Changes 2
Nothing new: every specific comes from your words or answers.

 Run it   Edit   Copy   Send original  Cancel
```

## The one rule

**The rewrite contains what you wrote and what you chose, and nothing else.**

Claude follows prompts literally, so anything a rewriter adds becomes an instruction you never gave. That includes an assumed audience, a format, a method, a "make sure to test" or a `[placeholder]`. Questions you skip stay unsaid, and Claude uses its own judgement there.

The rule is enforced in three places:

1. **The model's instructions.** They always fix spelling and grammar, allow smoothing a clumsy sentence, reordering what you said and working in your answers. They forbid adding anything: no new reason, time, condition or detail.
2. **A "Not from you" check.** Plain code flags any number, name, file path, URL, identifier or quoted text in the rewrite that you never typed or picked, and shows it in amber before you run.
3. **You.** The review screen shows both versions side by side, and nothing is sent until you choose.

The questions are just as strict. The mod asks only about gaps where a wrong guess would send Claude off to do noticeably different work, such as what a vague verb like "improve" or "clean up" should mean. It doesn't ask about anything Claude can find out by reading your project, and it never asks what "it" or "this" refers to, because Claude already sees your conversation and the mod doesn't. For a clear prompt it asks nothing.

## Install

You need Claude Code with plugin support. The mod is tested on Claude Code 2.1.295 (the build Claude Desktop runs) and 2.1.299. Mods are an early-access feature, so an older version may not load it.

**In a Claude Code terminal session**, type:

```
/plugin install prompt-enhancer --marketplace Hashemi-Amir/claude-prompt-enhancer
```

Answer `y` to add the marketplace, then pick a scope (Enter takes **user**, so the mod loads in every session). It's active right away.

**From a shell:**

```bash
claude plugin install prompt-enhancer --marketplace Hashemi-Amir/claude-prompt-enhancer
```

**Or in two steps**, adding the marketplace first:

```bash
claude plugin marketplace add Hashemi-Amir/claude-prompt-enhancer
claude plugin install prompt-enhancer@prompt-enhancer
```

**In the Claude desktop app**, where `/plugin` isn't available: click **+** next to the prompt box, choose **Plugins**, then **Add marketplace**. Enter `Hashemi-Amir/claude-prompt-enhancer`, then **Add plugin** and pick Prompt Enhancer.

To check it loaded, run `claude plugin list`; you should see `prompt-enhancer@prompt-enhancer` with `Status: ✔ enabled`. Or type `/enhance` in a session.

## Use it

| Command | What it does |
| --- | --- |
| `/enhance <prompt>` | Enhance that prompt in the pane |
| `/enhance` | Open the pane with a box to type a prompt |
| `/enhance on` / `/enhance off` | Turn automatic mode on or off; it's remembered across sessions and starts off |
| `/enhance history` | Your last 20 enhanced prompts; pick one to reopen its review |
| `/enhance history clear` | Empty the history |
| `/enhance settings` | Open the pane's Settings: which model asks the questions and which writes the rewrite |
| `/enhance cancel` | Close whatever is open in the pane and put your original prompt back |

### In the pane

1. **Your prompt.** It's read and checked for gaps only you can fill.
2. **Questions.** Pick an option chip, type your own answer with **Other**, or **Skip**. **Skip the rest, rewrite now** goes straight to the rewrite. If nothing is worth asking, this step is skipped.
3. **Rewrite.** Your prompt is rewritten from your words and answers.
4. **Review.** The buttons:
   - **Run it** sends the rewrite as your own message.
   - **Edit** lets you change it first. In the terminal it opens a text area that wraps the whole rewrite, the cursor after the last word: click in it to type, Enter runs it, Shift+Enter adds a line, Esc leaves the box. **Run it** below the box sends what you typed. The desktop app uses its own text box.
   - **Copy** copies the rewrite.
   - **Send original** sends exactly what you typed.
   - **Cancel** (or Esc) closes the pane and puts your original back in the prompt box.

The **⚙ Settings** button sits in the pane's header on every screen (key `m`); see [Settings](#settings).

Each button shows its key: `r` run, `e` edit, `c` copy, `o` send original, `x` cancel. Digits pick the options of the next open question.

If a model call fails, your prompt is safe. You get **Try again**, **Send original** and **Cancel**.

### Automatic mode

With `/enhance on`, a prompt you type opens in the pane instead of being sent, and `prompt enhancer: auto` shows among the mode labels at the right of the prompt footer. These always go straight through untouched:

- slash commands;
- anything typed while Claude is working;
- prompts with images, files or other attachments, and prompts with `@file` mentions, because a prompt the mod sends can't carry them;
- `!` shell commands;
- short replies under four words, like "yes" or "keep going";
- messages from other sessions, background tasks or plugins.

Start a prompt with `>` to send it as typed; the `>` is removed.

## Settings

| Setting | Values | Default |
| --- | --- | --- |
| `questionsModel` | `haiku` asks fewer, better-aimed questions; `sonnet` asks more; `opus` is the most careful and the slowest | `haiku` |
| `rewriteModel` | `sonnet` fixes grammar and reads most naturally; `haiku` is faster and stays closest to your exact words; `opus` is the most careful and the slowest | `sonnet` |

The quickest way to change them is in the pane: the **⚙ Settings** button in its header, or `/enhance settings`, shows a Haiku / Sonnet / Opus choice for each step. These are the same two settings as in `/config` (or `/plugin configure prompt-enhancer@prompt-enhancer`): a pick in the pane writes them there, so both places always show the same models.

## Cost and privacy

- Each enhancement makes up to two short model calls on your own Claude account: one for the questions (Haiku by default) and one for the rewrite (Sonnet by default). A reply that can't be read is retried once, and a call that takes longer than a minute counts as failed (your prompt is kept).
- The mod sees only the prompt you're enhancing, not your conversation or your files.
- History stays on your machine, in the mod's own store under `~/.claude/plugins/store/`. `/enhance history clear` empties it. If that store can't be read or written, the mod says so once and keeps working for the session without saving.

## Update and uninstall

To get a newer version:

```bash
claude plugin marketplace update prompt-enhancer
claude plugin update prompt-enhancer@prompt-enhancer
```

then run `/reload-plugins` in an open session, or start a new one.

To remove it:

```bash
claude plugin uninstall prompt-enhancer@prompt-enhancer
claude plugin marketplace remove prompt-enhancer
```

## Develop

```
.claude-plugin/
  plugin.json        manifest, the two model settings
  marketplace.json   makes this repository installable
hooks/
  hooks.json         names the hooks module
  register.tsx       everything that talks to Claude Code: /enhance, interception,
                     the steps, model calls, run/cancel/history, drawing the pane
  llm.ts             the two system prompts and reply parsing
  check.ts           the "Not from you" check
  intercept.ts       which prompts automatic mode catches
  look.ts            colours and small drawing helpers
  textarea.tsx       the terminal's edit box: wraps prose and keeps the whole text in view
types/index.d.ts     the mod's state contract
tests/               claude plugin test suites
```

Run a working copy without installing it:

```bash
claude --plugin-dir ./
```

Every function that receives `$` lives in `register.tsx`. Claude Code 2.1.295 follows `$` only into functions declared in the same file as the hook, so passing it into another file stops the mod from loading there.

Before you commit, check it:

```bash
claude plugin validate .
claude plugin test .
```

The two system prompts in `hooks/llm.ts` were tested against a fixed set of 17 rough prompts, including a non-English one, with a blind judge. The default pairing (questions on Haiku, rewrite on Sonnet) left almost no spelling or grammar errors, asked no needless questions, and added no requirements; its only slips were two small paraphrases that put obvious meaning into words. Opus, offered since 0.4, was not part of that evaluation. An "add a goal, audience, format and done-criteria" style of rewriting invented many details by comparison. Treat changes to the prompts as behaviour changes and test them the same way.

To release a change, raise `version` in `.claude-plugin/plugin.json`. Installed copies stay on the version they have until it changes.

## License

[MIT](LICENSE) © 2026 Amir Hashemi
