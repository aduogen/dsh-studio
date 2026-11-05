# DSH Studio

A canvas-first desktop studio built on the DeepSeek Harness engine.

Sessions are cards on an infinite board. Drag them anywhere; the board is the
main screen. Conversation, search, and everything else will open inside the
canvas later — this repository starts with the canvas itself.

## Why a separate app

The official DSH web GUI reserves the `main` slot for exactly one panel, so a
map plugin and a conversation cannot be visible at the same time. DSH Studio
owns its own window and talks to the engine over HTTP, so the layout is ours to
design.

## Architecture

```
DSH Studio (Electron)
      |  IPC (contextIsolation, no Node in the renderer)
      v
electron/main.mjs  ->  electron/engine.mjs  ->  HTTP + JSON-RPC
                                                        |
                                                        v
                              dsh web --no-open --port 0  (the engine)
```

The engine is started as a child process. It prints a URL carrying a one-time
token; `engine.mjs` exchanges that token for a session cookie and then talks to
`/api/<endpoint>` using the documented client envelope:

```json
{ "type": "client-request", "rpcId": "...", "method": "session/list", "payload": { "args": { "_request": {} } } }
```

## Requirements

- Windows with DeepSeek Harness installed at `E:\工具\DeepSeek harness`
- Node.js 22+

The engine paths are absolute in `electron/engine.mjs`; adjust `DSH_EXE` and
`DSH_CLI` if your install differs.

## 启动方式（Windows）

三种都可以：

1. **桌面快捷方式**：双击桌面的 **DSH Studio**
2. **项目里的批处理**：双击 `E:\dsh-studio\启动 DSH Studio.cmd`
3. **命令行**：
   ```bash
   cd /d E:\dsh-studio
   node_modules\electron\dist\electron.exe .
   ```

第一次启动会花 5–10 秒（要拉起内核），之后界面直接可用。

如果窗口没出现，看 `E:\dsh-studio\boot.log`，最后几行会写明卡在哪一步。

## Run

```bash
npm install
npm start          # normal launch
node _shot.mjs     # screenshot the window to shot.png for verification
node _dump.mjs     # dump the rendered DOM to dom.json
```

## Current state

- Infinite canvas with dotted grid, pan, zoom, and fit
- Session cards from `session/list` (title, relative time, running lamp, cwd)
- Drag cards; positions persist per user data
- Click a card to select it (the hook for the side panel to come)

## Next

- Conversation panel opening inside the canvas when a card is clicked
- Edges between cards with injected context (the fork-spawn flow)
- Workspace grouping frames
