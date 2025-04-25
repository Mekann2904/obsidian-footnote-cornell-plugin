# Cornell Footnote プラグイン

Obsidian 上で Markdown の脚注（footnote）定義と参照を「Source ノート」と「Cue ノート」に分けて管理・同期するプラグインです。以下のような機能を提供します。

---

## 主な機能

- **Source → Cue の自動／手動同期**  
  Source ノートで脚注定義を編集すると、対応する Cue ノートに定義が反映されます。

- **Cue → Source の自動／手動同期**  
  Cue ノートで脚注定義を編集すると、対応する Source ノートに定義・参照が反映されます。

- **コードブロック内ボタンによるナビゲーション**  
  Cue ノート内の脚注一覧ボタンをクリックして Source ノートの該当参照へ移動、Ctrl/Cmd+クリックでハイライト表示。

- **Arrange ビュー**  
  ``Arrange Cornell Notes View`` コマンドで Source／Cue／Summary ノートを分割表示し、一気に編集環境を整えます。

- **カスタマイズ性**  
  設定タブから同期動作、削除動作、リンクテンプレートなどを細かく設定可能。

---

## インストール

1. このプラグインを ZIP で配布している場合は解凍し、フォルダ名を `obsidian-cornell-footnote` 等にリネーム。  
2. Obsidian の `Vault/.obsidian/plugins/obsidian-cornell-footnote/` 配下に配置。  
3. Obsidian の「設定」→「コミュニティプラグイン」→「インストール済みプラグイン」から有効化。  
4. コマンドパレット（Ctrl/Cmd+P）で `Cornell Footnote` 系コマンドを確認可能。

---

## 使い方

### 1. Arrange Cornell Notes View

- Source ノートをアクティブにして、コマンドパレットから `Arrange Cornell Notes View` を実行。  
- Source／Cue／Summary ノートを自動で分割表示します。Cue・Summary ノートがなければ新規作成。

### 2. 自動同期／手動同期

- **自動同期**：  
  設定タブで「Enable Automatic Sync on Save」を有効化すると、保存時に自動で同期を実行します（要注意）。  
- **手動同期**：  
  - `Manual Sync: Source -> Cue`  
    Source ノート上で実行すると Cue ノートへ同期。  
  - `Manual Sync: Cue -> Source`  
    Cue ノート上で実行すると Source ノートへ同期。  
  - `Sync All Notes (Source -> Cue)`  
    Vault 内の全ての Source ノートを一括同期。

### 3. コードブロック内ボタン操作

Cue ノートに脚注定義を元に生成されるコードブロック内に以下の操作が可能です：  

- **シングルクリック**：該当する Source ノート内の脚注参照へ移動  
- **Ctrl/Cmd + クリック**：最初の脚注参照をハイライト（短時間強調表示）

---

## 設定（Settings）

1. **Synchronization**  
   - Enable Automatic Sync on Save  
2. **Deletion**  
   - Auto Delete References in Source (Dangerous!)  
   - Auto Delete Definition in Cue  
3. **Footnote Positioning**  
   - Move Footnotes to End of Source Note  
4. **Cue Note Interaction**  
   - Enable Click Navigation  
   - Enable Ctrl/Cmd + Click Highlight  
5. **Link Templates**  
   - Link to Source Template  
   - Link to Cue Template

各項目の詳しい説明は設定タブの説明文をご覧ください。

---

## コマンド一覧

- `Arrange Cornell Notes View`  
- `Manual Sync: Source -> Cue`  
- `Manual Sync: Cue -> Source`  
- `Sync All Notes (Source -> Cue)`  
- `Highlight First Reference in Source (from Cue def/cursor)`

---

## 注意事項

- **自動同期** は複雑な編集状況下で意図しない上書きが発生する可能性があります。まずは手動同期で動作を確認してください。  
- **Dangerous** な削除設定（参照・定義の自動削除）は必ずバックアップを取った上でご利用ください。

---

## ライセンス

MIT License

---

© 2025 Cornell Footnote Plugin Mekann
