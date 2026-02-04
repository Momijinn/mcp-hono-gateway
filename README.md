# mcp-hono-gateway

Hono で作った「MCP Streamable HTTP ゲートウェイ」です。  
ローカルで動く MCP サーバー（stdio で JSON-RPC を話すもの）を、HTTP 経由で呼べるようにします。

## できること

- MCP サーバーを HTTP のエンドポイントとして公開（`POST/GET/DELETE`）
- `initialize` でセッションを開始し、以降は `mcp-session-id` で同一セッションを継続
- サーバープロセスはセッションごとに spawn され、セッション終了時にクリーンアップ

## 必要なもの（ローカル開発）

- Node.js
- `uv`（`uvx` を使うルートがあるため）
  - このリポジトリは [mise.toml](mise.toml) にバージョン例があります

## まず動かす（ローカル）

```sh
npm install
npm run dev
```

ブラウザ/クライアントからアクセス:

```sh
open http://localhost:3000
```

## エンドポイント一覧（MCP Streamable HTTP）

このアプリは MCP サーバーを HTTP ルートとして公開します。

- `POST/GET/DELETE /server-time`
- `POST/GET/DELETE /aws-pricing`
- `POST/GET/DELETE /aws-knowledge`
- `POST/GET/DELETE /context7`
- `POST/GET/DELETE /tavily`
- `POST/GET/DELETE /yfmcp`

## 使い方（MCP セッションの流れ）

### 必須ヘッダー

MCP Streamable HTTP は「JSON」と「SSE」を両方受けられる必要があります。

- `Accept: application/json, text/event-stream`

### セッション開始（initialize）

最初の `initialize` が成功するとレスポンスヘッダーにセッション ID が返ります。

- `mcp-session-id: <uuid>`

以降のリクエストは同じ `mcp-session-id` を付けて呼び出します。

### 推奨: MCP Inspector で確認する

curl で JSON-RPC を手で組むより、MCP Inspector の UI で接続・疎通確認する方法を推奨します。

1) ゲートウェイを起動（例: `npm run dev`）
2) Inspector を起動: `npm run inspector`
3) ブラウザで `http://localhost:6274` を開き、`mcp-inspector.json` のサーバー（例: `aws-pricing`）を選んで接続

補足:

- `npm run inspector` は既定で `--server default-server` を指定して起動します（設定は [mcp-inspector.json](mcp-inspector.json)）。
- 別のサーバーで開きたい場合: `npm run inspector -- --server aws-knowledge`
- `BEARER_TOKEN` を有効にしている場合、Inspector 側で `Authorization: Bearer <token>` を送る必要があります。
- 設定ファイルは [mcp-inspector.json](mcp-inspector.json) にあります（`http://localhost:3000/<route>` を前提）。

## 環境変数

必要に応じて `.env.example` を `.env` にコピーして設定してください。

- `BEARER_TOKEN`（任意）: 設定すると全ルートに Bearer 認証が掛かります（`Authorization: Bearer <token>` が必須）
- `AWS_REGION`（任意。未指定なら `us-east-1`）: `/aws-pricing` の実行環境で使用
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`（必要な場合）: AWS 系 MCP サーバーが参照
- `CONTEXT7_API_KEY`（推奨）: `/context7` で使用（未設定でも起動はできますが、`/context7` のリクエストはエラーになります）
- `TAVILY_API_KEY`（推奨）: `/tavily` で使用（未設定でも起動はできますが、`/tavily` のリクエストはエラーになります）
- `CLOUDFLARED_TUNNEL_TOKEN`（Cloudflare Tunnel を使う場合）: `cloudflared` コンテナで使用

### セッション/メモリ関連（任意）

このゲートウェイは `initialize` ごとに MCP サーバープロセスを起動します。
クライアントがセッションを閉じ忘れるとプロセスが残り続けてメモリを消費するため、アイドル/長寿命セッションを自動でクリーンアップする設定を用意しています。

- `MCP_MAX_SESSIONS`（compose 既定: `10`）: 同時に保持するセッション数の上限（超えると `initialize` を `503` で拒否）
- `MCP_SESSION_IDLE_MS`（compose 既定: `300000` = 5分）: この時間アクセスがないセッションを自動終了（`0` で無効化）
- `MCP_SESSION_MAX_LIFETIME_MS`（compose 既定: `3600000` = 1時間）: セッションの最大生存時間（`0` で無効化）
- `MCP_MAX_INIT_BODY_BYTES`（compose 既定: `250000` ≒ 250KB）: `initialize` の JSON ボディが大きすぎる場合に `413` で拒否
- `MCP_LOG_MEMORY`（任意。`1` で有効化）: 1分ごとに `sessions` 数と `process.memoryUsage()` をログ出力

## Docker

### Cloudflare Tunnel 経由で公開する（compose デフォルト）

`compose.yaml` の通常起動は `app` と `cloudflared` を立ち上げます。
この構成ではホストに `3000` を publish していないため、ローカルから `http://localhost:3000` で叩く用途には向きません。

```sh
docker compose up --build
```

停止/片付け:

```sh
docker compose down
```

### ローカルで叩きたい（ホットリロード付き）

ポート公開がある dev profile を使います。

```sh
docker compose --profile dev up --build app-dev
```

停止/片付け（dev profile）:

```sh
docker compose --profile dev down
```

## MCP サーバーを追加する

### ジェネレーター（推奨）

ルートファイル作成 + `src/index.ts` への mount を自動で行います。

```sh
npm run add:mcp -- --name my-tool
```

よく使うオプション例:

```sh
# uvx (Python パッケージを実行)
npm run add:mcp -- --name aws-like --command uvx --arg 'some.package@latest' --env AWS_REGION

# npx (Node パッケージを実行)
npm run add:mcp -- --name node-mcp --command npx --arg -y --arg @your/mcp-server
```

### 手動で追加する場合

1) `src/routes/` にルートを作る（`createMcpProxy` を使う）
2) `src/index.ts` で `app.route('/your-path', yourRoute)` を追加
3) 環境変数が必要なら `compose.yaml` の `environment:` に通す
4) コンテナ内で実行できるコマンドか確認（`uvx` / `npx` はイメージに含まれます）

## Biome（Lint / Format）

```sh
npm run lint
npm run format
npm run check
```

VS Code は biome 拡張を入れると保存時フォーマット/修正が動きます（設定は `.vscode/` 配下）。

## License

MIT License
