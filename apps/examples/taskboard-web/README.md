# Task board in a web app

An agent with Cerebriline's task board and the Board tab, in a page of your
own. It is the smallest whole integration of the three packages:

- `@cline/agents` (`@cerebriline/agents` on npm) runs the agent loop;
- `@cline/taskboard` gives that loop the board (`attachTaskBoard`) and
  answers the Board tab (`createBoardBackend`, `sessionBoardSlots`);
- `@cline/ui/components/board-viewer` draws the Board tab.

You chat on the left. The agent plans the work on the board at the right and
works through it; you can add, change and reorder tasks while it works, and it
is told what you changed. The same tab shows the workspace's pipelines and
their runs, three draft boards, the past conversations' boards and the boards
you saved.

## Run it

```bash
cd apps/examples/taskboard-web
bun install
bun run build:sdk          # once: the SDK packages' dist
bun dev [workspace]        # builds the page, starts http://127.0.0.1:3477
```

The workspace is the folder the agent works in (default: the current one).
Its `.cerebriline/` holds what the board keeps: pipelines, the conversations'
board logs (`conversations/`), drafts and saved boards (`boards/`).

The model comes from the environment. The default is Ollama on this machine
with `qwen3:8b`:

| Variable | Default | |
|---|---|---|
| `PROVIDER` | `ollama` | any provider id `@cline/llms` knows (`openai`, `anthropic`, `openrouter`, ...) |
| `MODEL` | `qwen3:8b` | |
| `BASE_URL` | the provider's | for Ollama elsewhere: `http://host:11434` |
| `API_KEY` | none | |
| `PORT` | `3477` | |

## How it fits together

```
 page (web/)                          server (server/)
 ┌──────────────┬───────────────┐     ┌──────────────────────────────────────┐
 │ chat         │ <BoardViewer> │ ws  │ Conversation: Agent + attachTaskBoard │
 │              │  transport ───┼─────┼─> createBoardBackend (one per page)   │
 │ <Dialog>  <──┼───────────────┼─────┼── its questions (pageDialogs)        │
 └──────────────┴───────────────┘     │   sessionBoardSlots: every board     │
                                      └──────────────────────────────────────┘
```

One WebSocket carries three channels (`shared/wire.ts`):

- **board**: the Board tab's own messages, passed through untouched. The
  page's transport (`web/socket.ts`) is the tab's `send` and `subscribe`.
- **chat**: what you send, what the agent says, and whether it is running.
- **dialog**: the board backend asks you something (a pipeline's name,
  Approve or not, which file). A server cannot open a dialog, so
  `server/dialogs.ts` sends the question and `web/Dialog.tsx` answers it.

The files to read, in order:

1. `server/conversation.ts`: the agent loop with the board attached. Five
   lines of wiring, each at its point in the loop.
2. `server/index.ts`: the board backend, the boards it lists, pushing the
   tab's data when the board changes, and starting a conversation from a
   draft.
3. `server/dialogs.ts`: the backend's questions, asked in the page.
4. `web/socket.ts` and `web/App.tsx`: the page.

## Notes

- **Pipelines are on.** The agent can save, test and run pipelines; one it
  saves runs only after you approve it on the Board tab. A pipeline step that
  wants a tool which asks first asks you in the page.
- **Recent conversations** are listed by id: the example keeps no titles.
- **One React.** In this repository the ui package has its own development
  copy of React, so `vite.config.ts` dedupes it. Installed from npm, React is
  a peer of the ui package and there is only one.
- The file tools are confined to the workspace. The server listens on
  127.0.0.1 only: anyone who can open the page can drive the agent.

The guide: [Embedding the task board](../../../docs/sdk/guides/embedding-the-task-board.mdx).
