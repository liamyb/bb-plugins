---
name: pane-keeper-draft
description: Open a pre-filled, unsent New thread in the bb app beside the user's focused pane with `bb pane-keeper draft`. Use when the user wants a prompt set up for them to review, add to and send themselves, rather than a thread that starts straight away (which is `bb thread spawn`).
---

# Pane Keeper drafts

`bb pane-keeper draft` puts a prompt into New thread's composer in the bb app and sends
nothing. The user adds context, picks the mode and sends it themselves.

```sh
bb pane-keeper draft --project <project id> --environment <env id or checkout path> \
  --wait 20s --json --prompt "$(cat <<'EOF'
The prompt, as the user should see it.
EOF
)"
```

- `--project` defaults to the invoking thread's project. `--environment` takes an
  environment id or a checkout path, the same as `bb thread spawn --environment`. Left out,
  New thread keeps its own environment choice.
- The prompt is capped at 8,000 characters and keeps its line breaks. There's no
  `--prompt-stdin`, because bb's stdin form only takes a single line.
- New thread opens beside the focused pane (beside a single pane too), on the given project
  and environment. The prompt goes after anything the user had already typed there, as its
  own paragraph, and a prompt that's already there isn't added twice.
- At 8 panes with nothing safe to swap out, or when New thread doesn't appear, the prompt is
  copied to the clipboard and a toast says so.
- A draft waits up to 10 minutes for a bb window to load, and exactly one window takes it.
- `--wait` (up to 60s) reports what happened: `inserted`, `already-there`, `clipboard` or
  `failed`. `queued` means no window had taken it yet, and `claimed` means one took it and
  hasn't reported back.
- Exit 0 only means the draft was queued. It's in New thread when the status is `inserted`
  or `already-there`.
