# pi-imap

[pi coding agent](https://github.com/earendil-works/pi) から IMAP メールボックスを操作するための拡張機能です。

- **読み取り専用モード（既定）**: メールボックス一覧・検索・本文の閲覧だけができます。
- **読み書きモード**: 上記に加えて、フラグ変更・移動・削除ができます。

モードを切り替えられるのは利用者だけです。モデル（エージェント）が自分でモードを変えることはできません。

## インストール

```bash
pi install git:github.com/firestarter2501/pi-imap
```

一度だけ試す場合:

```bash
pi -e git:github.com/firestarter2501/pi-imap
```

## 設定

接続情報は環境変数で渡します。

| 変数 | 必須 | 説明 |
|---|---|---|
| `IMAP_HOST` | ✓ | IMAP サーバーのホスト名 |
| `IMAP_USER` | ✓ | ユーザー名 |
| `IMAP_PASSWORD` | ✓ | パスワード（Gmail などはアプリパスワード） |
| `IMAP_PORT` | | ポート番号。既定は `993` |
| `IMAP_SECURE` | | `false` にすると平文接続で開始し、サーバーが対応していれば STARTTLS に切り替えます。既定はポート 993 なら `true` |
| `IMAP_MODE` | | 起動時のモード。`read-only`（既定）または `read-write` |
| `IMAP_TIMEOUT` | | 接続時やサーバーが応答しないときに諦めるまでの秒数。既定は `60` |
| `IMAP_TLS_REJECT_UNAUTHORIZED` | | `false` にすると証明書を検証しません。自己署名証明書のサーバー専用で、通常は設定しないでください |

例:

```bash
export IMAP_HOST=imap.gmail.com
export IMAP_USER=you@gmail.com
export IMAP_PASSWORD='xxxx xxxx xxxx xxxx'
pi
```

## モードの切り替え

| 方法 | 例 |
|---|---|
| pi 内のコマンド | `/imap-mode read-write`、`/imap-mode read-only`、`/imap-mode`（現在のモードを表示） |
| 起動フラグ | `pi --imap-mode read-write` |
| 環境変数 | `IMAP_MODE=read-write pi` |

現在のモードはフッターに `IMAP: read-only` / `IMAP: read-write` と表示されます。

読み取り専用モードでは書き込み用ツールがモデルから見えなくなります。さらに念のため、書き込み用ツール自体も読み取り専用モードでは実行を拒否します。

`/imap-mode` で変えたモードは保存されません。新しいセッションを始めると、フラグ・環境変数で指定したモード（未指定なら読み取り専用）に戻ります。

> **注意**: メール本文は第三者が自由に書ける内容です。「このメールを削除して」のような指示がメールに埋め込まれている可能性があるため、読み書きモードは必要なときだけ有効にしてください。

## ツール一覧

### 読み取り（常に使用可能）

| ツール | 内容 |
|---|---|
| `imap_list_mailboxes` | メールボックス（フォルダ）の一覧と件数・未読数 |
| `imap_search` | 差出人・宛先・件名・本文・日付・未読で検索（新しい順、既定 20 件） |
| `imap_read` | UID を指定してメールを読む（ヘッダー・本文・添付ファイル一覧） |

読み取り系はメールボックスを `EXAMINE`（読み取り専用）で開くので、メールを読んでも既読にはなりません。

### 書き込み（読み書きモードのみ）

| ツール | 内容 |
|---|---|
| `imap_set_flags` | フラグの追加・削除（例: `\Seen` で既読、`\Flagged` でスター） |
| `imap_move` | 別のメールボックスへ移動 |
| `imap_delete` | 完全に削除。対話モードでは実行前に確認ダイアログが出ます |

## 依存ライブラリ

| ライブラリ | 用途 | 選定理由 |
|---|---|---|
| [imapflow](https://github.com/postalsys/imapflow) | IMAP クライアント | Nodemailer の作者が保守。MIT、週 200 万以上のダウンロード |
| [mailparser](https://github.com/nodemailer/mailparser) | メール本文の解析（MIME・文字コード・HTML→テキスト） | Nodemailer プロジェクト公式。MIT、週 500 万以上のダウンロード |

どちらもバージョンを固定しています。`typebox` と `@earendil-works/pi-coding-agent` は pi 本体が提供するため `peerDependencies` にしています。

## 開発

開発は podman 上で行います。ホストに Node.js を入れる必要はありません。

```bash
scripts/dev.sh test        # 依存のインストール、型チェック、テスト
scripts/dev.sh npm <args>  # Node コンテナで任意の npm コマンド
scripts/dev.sh shell       # Node コンテナのシェル
scripts/dev.sh down        # テスト用 Pod を削除
```

`scripts/dev.sh` は Pod を1つ作り、その中で次の2つのコンテナを動かします。

- Dovecot（テスト用 IMAP サーバー。ユーザー名は任意、パスワードは `secret`）
- Node.js（このリポジトリを `/app` にマウント）

### ファイル構成

```
src/index.ts   pi へのツール・コマンド登録とモード管理
src/imap.ts    IMAP の操作（imapflow / mailparser の薄いラッパー）
test/          Dovecot を相手にした結合テスト（接続断・無応答の再現を含む）
scripts/dev.sh podman 用の開発スクリプト
```

## ライセンス

MIT
