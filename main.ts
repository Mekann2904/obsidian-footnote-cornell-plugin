import {
	App,
	Editor,
	EditorPosition, // 行番号取得・移動に必要
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
	WorkspaceLeaf,
	normalizePath,
	debounce, // Obsidian の debounce 関数
	MarkdownPostProcessorContext,
	// setIcon, // 必要ならコメント解除
	TAbstractFile,
	SplitDirection,
    MarkdownFileInfo,
    EditorSelection // 選択範囲の型
} from 'obsidian';

// --- 定数 ---

/** プラグインのデフォルト設定 */
const DEFAULT_SETTINGS: Required<CornellFootnoteSettings> = {
	syncOnSave: false,
	deleteReferencesOnDefinitionDelete: false,
    deleteDefinitionsOnReferenceDelete: false,
	linkToSourceText: '[[{{sourceNote}}|⬅️ Back to Source]]',
	linkToCueText: '[[{{cueNote}}|⬅️ Back to Cue]]',
	enableCueNoteNavigation: true, // コードブロックボタンのクリックナビゲーション
    // showReferencesInCue: true, // 廃止
    enableModifierClickHighlight: true, // コードブロックボタンの修飾キー付きクリックハイライト
    moveFootnotesToEnd: true, // Sourceノートの脚注を末尾に移動する設定 (C->S Sync時)
};

/** 内部定数 */
const INTERNAL_SETTINGS = {
	cueNoteSuffix: '-cue',
	cueNoteFolder: '', // 将来的な拡張用 (現在は未使用、Sourceと同じフォルダに作成)
	summaryNoteSuffix: '-summary',
	summaryNoteFolder: '', // 将来的な拡張用 (現在は未使用、Sourceと同じフォルダに作成)
	syncDebounceTime: 1500, // 自動同期の遅延時間 (ms)
	batchSyncUpdateInterval: 50, // 全ノート同期時のUI更新間隔 (ノート数)
	uiUpdateDelay: 250, // UI操作後の待機時間 (ms)
	syncFlagReleaseDelay: 100, // 同期フラグ解除前の最小待機時間 (ms)
    highlightDuration: 1500, // ハイライト表示時間 (ms)
    codeBlockProcessorId: 'cornell-footnote-links', // カスタムコードブロックのID
};

// --- インターフェース ---

/** プラグインのユーザー設定可能な設定を表す */
interface CornellFootnoteSettings {
	syncOnSave: boolean; // 保存時に自動同期するか
	deleteReferencesOnDefinitionDelete: boolean; // C->S同期時: Cueで定義削除されたらSourceの参照も削除するか
    deleteDefinitionsOnReferenceDelete: boolean; // S->C同期時: Sourceで全参照削除されたらCueの定義も削除するか
	linkToSourceText: string; // Cue/Summaryノートに挿入するSourceノートへのリンクテキスト
	linkToCueText: string; // Summaryノートに挿入するCueノートへのリンクテキスト
	enableCueNoteNavigation: boolean; // コードブロックボタン: クリックでSource参照へナビゲート
    // showReferencesInCue: boolean; // 廃止
    enableModifierClickHighlight: boolean; // コードブロックボタン: Ctrl/Cmd+クリックでSource参照をハイライト
    /** Cue -> Source 同期時にSourceノートの脚注定義を末尾に移動するか */
    moveFootnotesToEnd: boolean;
}

/** DebouncedFunction インターフェース */
interface DebouncedFunction<TArgs extends any[]> {
    (...args: TArgs): void;
    cancel(): void;
}

/** 位置情報インターフェース */
interface Position {
	start: number; // 文字列内の開始位置
	end: number; // 文字列内の終了位置
}

/** 解析された脚注定義の情報 */
interface ParsedDefinition extends Position {
	ref: string; // 参照名 (例: "1", "abc")
	definition: string; // 定義内容 (例: "This is a note.")
	fullMatch: string; // 正規表現にマッチした文字列全体 (例: "[^1]: This is a note.")
}

/** 解析された脚注参照の情報 */
interface ParsedReference extends Position {
	ref: string; // 参照名 (例: "1", "abc")
	fullMatch: string; // 正規表現にマッチした文字列全体 (例: "[^1]")
}

/** 保存するノート関連情報 */
interface CornellNoteInfo {
    sourcePath: string; // Sourceノートのパス
    cuePath: string | null; // 対応するCueノートのパス (存在しない場合はnull)
    summaryPath: string | null; // 対応するSummaryノートのパス (存在しない場合はnull)
    lastSyncSourceToCue: number | null; // Source->Cueの最終同期時刻 (Unixタイムスタンプ)
    lastSyncCueToSource: number | null; // Cue->Sourceの最終同期時刻 (Unixタイムスタンプ)
}

// --- メインプラグインクラス ---

export default class CornellFootnotePlugin extends Plugin {
	settings: CornellFootnoteSettings;
	// 自動同期用のDebounce関数
	private debouncedSyncSourceToCue!: DebouncedFunction<[TFile]>;
	private debouncedSyncCueToSource!: DebouncedFunction<[TFile]>;
    // 同期処理中のフラグ（ループ防止用）
    private isSyncing: boolean = false;
    // Sourceノートパスをキーとする関連ノート情報マップ
    private noteInfoMap: Map<string, CornellNoteInfo> = new Map();
    // クリック時のハイライト解除タイマー
    private activeHighlightTimeout: NodeJS.Timeout | null = null;

	async onload() {
		console.log('Loading Cornell Footnote plugin (v Cue Ref Fix & Settings Cleanup)');
		await this.loadSettingsAndNoteInfo();
		await this.initializeOrUpdateNoteInfoMap(); // 起動時にマップを初期化/更新

		// Debounce関数を初期化 (連続変更時に同期が頻発するのを防ぐ)
		this.debouncedSyncSourceToCue = debounce( this.syncSourceToCue, INTERNAL_SETTINGS.syncDebounceTime, true ) as DebouncedFunction<[TFile]>;
		this.debouncedSyncCueToSource = debounce( this.syncCueToSource, INTERNAL_SETTINGS.syncDebounceTime, true ) as DebouncedFunction<[TFile]>;

		// 設定タブを追加
		this.addSettingTab(new CornellFootnoteSettingTab(this.app, this));

		// ファイル変更イベントを登録 (自動同期用)
		this.registerEvent(this.app.vault.on('modify', this.handleFileModifyForAutoSync));

		// --- コマンド登録 ---
		this.addCommand({
			id: 'sync-source-to-cue-manually',
			name: 'Manual Sync: Source -> Cue',
			editorCallback: (editor: Editor, view: MarkdownView) => this.manualSyncHandler(view, 'S->C')
		});
        this.addCommand({
            id: 'sync-cue-to-source-manually',
            name: 'Manual Sync: Cue -> Source',
            editorCheckCallback: (checking: boolean, editor: Editor, view: MarkdownView) => this.manualSyncHandler(view, 'C->S', checking)
        });
		this.addCommand({
			id: 'sync-all-notes-source-to-cue',
			name: 'Sync All Notes (Source -> Cue)',
			callback: async () => {
				new Notice('Starting full sync (S->C) for all notes...', 3000);
				await this.processAllNotesSourceToCue()
				  .catch(err => { console.error('Error during full sync (S->C):', err); new Notice('Full sync (S->C) failed. See console.'); });
			},
		});
		this.addCommand({
			id: 'arrange-cornell-notes',
			name: 'Arrange Cornell Notes View',
			editorCallback: (editor: Editor, view: MarkdownView) => {
                const file = view.file;
				if (file && !this.isCueNote(file.path) && !this.isSummaryNote(file.path)) {
                    // Sourceノートから実行された場合、ビューを配置し、必要ならCue/Summaryを作成
					this.arrangeCornellNotesView(file, view.leaf)
						.then(() => new Notice(`Arranged view for ${file.basename}. Cue/Summary notes created if needed.`))
						.catch(err => {
							console.error(`Error arranging view for ${file.path}:`, err);
							new Notice('Error arranging view. See console.');
						});
				} else if (file) {
					new Notice('Cannot arrange view from a cue or summary note. Run from the source note.');
				} else {
					new Notice('No active file to arrange view for.');
				}
            },
		});
		this.addCommand({
			id: 'highlight-first-source-reference',
			name: 'Highlight First Reference in Source (from Cue def/cursor)',
			editorCheckCallback: (checking: boolean, editor: Editor, view: MarkdownView) => {
                // Cueノートで、脚注定義行または生成されたリンクボタン行にカーソルがある場合に実行可能
                if (view.file && this.isCueNote(view.file.path)) {
					if (!checking) { // コマンド実行時
						const cursor = editor.getCursor();
						const currentLine = editor.getLine(cursor.line);
						// 定義行 ([^ref]:) またはリンクボタン行 ([^ref]) から参照名を取得
						const defMatch = currentLine.match(/^\s*\[\^([^\]]+?)\]:/);
                        const cbRefMatch = currentLine.match(/^\s*\[\^(\w+?)\]/); // コードブロック内のボタンテキストを想定
                        const ref = defMatch?.[1]?.trim() || cbRefMatch?.[1]?.trim();
						if (ref) {
                            // 対応するSourceノートの最初の参照をハイライト
							this.highlightFirstSourceReference(ref, view.file.path)
								.catch(err => {
									console.error(`Error highlighting source for ref [${ref}] via command from ${view.file?.path}:`, err);
                                    new Notice(`Error highlighting ref [${ref}]. See console.`);
								});
						} else {
                            new Notice("Place cursor on a footnote definition line ([^ref]:) or within the text of a generated link button ([^ref]) to run this command.");
						}
					}
					return true; // コマンドを有効にする
				}
				return false; // Cueノート以外ではコマンドを無効にする
            }
		});

        // --- カスタムコードブロックプロセッサを登録 ---
        // Cueノート内の `cornell-footnote-links` コードブロックを処理
        this.registerMarkdownCodeBlockProcessor(
            INTERNAL_SETTINGS.codeBlockProcessorId,
            this.cornellLinksCodeBlockProcessor
        );

		console.log('Cornell Footnote plugin loaded successfully (v Cue Ref Fix & Settings Cleanup).');
	}

	onunload() {
		console.log('Unloading Cornell Footnote plugin');
		// Debounce関数をキャンセル
		this.debouncedSyncSourceToCue?.cancel();
		this.debouncedSyncCueToSource?.cancel();
        // 残っているハイライト解除タイマーをクリア
        if (this.activeHighlightTimeout) { clearTimeout(this.activeHighlightTimeout); this.activeHighlightTimeout = null; }
	}

	// --- データロード/保存 ---
    /** 設定とノート関連情報をロード */
    async loadSettingsAndNoteInfo() {
        const savedData = await this.loadData(); // プラグインデータをロード
        const loadedSettings = savedData?.settings ?? {};

        // デフォルト設定とロードした設定をマージ
        this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedSettings);

        // 古い/不要な設定キーを削除 (マイグレーション)
        ['autoArrangeOnFootnoteCreate', 'someOtherOldSetting', 'showReferencesInCue'].forEach(key => {
            if ((this.settings as any)[key] !== undefined) delete (this.settings as any)[key];
        });

        // 設定値の型チェックとデフォルト値へのフォールバック
        if (typeof this.settings.deleteReferencesOnDefinitionDelete !== 'boolean') this.settings.deleteReferencesOnDefinitionDelete = DEFAULT_SETTINGS.deleteReferencesOnDefinitionDelete;
        if (typeof this.settings.deleteDefinitionsOnReferenceDelete !== 'boolean') this.settings.deleteDefinitionsOnReferenceDelete = DEFAULT_SETTINGS.deleteDefinitionsOnReferenceDelete;
        if (typeof this.settings.syncOnSave !== 'boolean') this.settings.syncOnSave = DEFAULT_SETTINGS.syncOnSave;
        // if (typeof this.settings.showReferencesInCue !== 'boolean') this.settings.showReferencesInCue = DEFAULT_SETTINGS.showReferencesInCue; // 廃止
        if (typeof this.settings.enableCueNoteNavigation !== 'boolean') this.settings.enableCueNoteNavigation = DEFAULT_SETTINGS.enableCueNoteNavigation;
        if (typeof this.settings.enableModifierClickHighlight !== 'boolean') this.settings.enableModifierClickHighlight = DEFAULT_SETTINGS.enableModifierClickHighlight;
        if (typeof this.settings.moveFootnotesToEnd !== 'boolean') this.settings.moveFootnotesToEnd = DEFAULT_SETTINGS.moveFootnotesToEnd;

        // NoteInfoMap のロードと検証
        this.noteInfoMap = new Map<string, CornellNoteInfo>();
        if (savedData?.noteInfoMap && typeof savedData.noteInfoMap === 'object') {
            try {
                for (const [key, value] of Object.entries(savedData.noteInfoMap)) {
                    if (this.isValidCornellNoteInfo(key, value)) {
                        this.noteInfoMap.set(key, value as CornellNoteInfo);
                    } else {
                        console.warn("Invalid NoteInfo data found during load for key:", key, "Data:", value);
                    }
                }
                console.log(`Loaded ${this.noteInfoMap.size} entries into noteInfoMap.`);
            } catch (e) {
                console.error("Failed to deserialize noteInfoMap:", e);
                this.noteInfoMap = new Map(); // エラー時は空にする
            }
        } else {
            console.log("No valid saved noteInfoMap found, initializing empty map.");
        }
    }

    /** ロード時にNoteInfoデータが有効か検証するヘルパー */
    private isValidCornellNoteInfo(key: any, value: any): boolean {
        return typeof key === 'string' &&
               typeof value === 'object' && value !== null &&
               'sourcePath' in value && typeof value.sourcePath === 'string' &&
               'cuePath' in value && (value.cuePath === null || typeof value.cuePath === 'string') &&
               'summaryPath' in value && (value.summaryPath === null || typeof value.summaryPath === 'string') &&
               'lastSyncSourceToCue' in value && (value.lastSyncSourceToCue === null || typeof value.lastSyncSourceToCue === 'number') &&
               'lastSyncCueToSource' in value && (value.lastSyncCueToSource === null || typeof value.lastSyncCueToSource === 'number');
    }

	/** 設定とNoteInfoMapを保存 */
	async saveData() {
        // Mapをシリアライズ可能なオブジェクトに変換
        const serializableMap: { [key: string]: CornellNoteInfo } = {};
        for (const [key, value] of this.noteInfoMap.entries()) {
            serializableMap[key] = value;
        }
        // 設定と変換したマップを保存
        await super.saveData({ settings: this.settings, noteInfoMap: serializableMap });
	}

    /** 設定のみを保存 (設定タブからの変更時など) */
    async saveSettings() {
        // 古い/不要な設定キーを削除
        ['autoArrangeOnFootnoteCreate', 'someOtherOldSetting', 'showReferencesInCue'].forEach(key => {
            if ((this.settings as any)[key] !== undefined) delete (this.settings as any)[key];
        });
        await this.saveData(); // 設定とNoteInfoMapをまとめて保存
        // UIの再描画をトリガー (必要に応じて)
        this.app.workspace.trigger('layout-change');
    }

	// --- NoteInfoMap の初期化/更新処理 ---
    /** Vault内の全Markdownファイルをスキャンし、NoteInfoMapを最新の状態に更新 */
    async initializeOrUpdateNoteInfoMap() {
        console.log("[Cornell FP] Initializing or updating Note Info Map...");
        const allMarkdownFiles = this.app.vault.getMarkdownFiles();
        const currentMapKeys = new Set(this.noteInfoMap.keys()); // 現在マップにあるSourcePath
        let added = 0, updated = 0, removed = 0;
        let mapChanged = false; // マップが変更されたか

        // 全ファイルを並列で処理
        await Promise.all(allMarkdownFiles.map(async file => {
            // Cue/Summaryノートはスキップ (Sourceノートのみ対象)
            if (this.isCueNote(file.path) || this.isSummaryNote(file.path)) return;

            const sourcePath = file.path;
            // Sourceノートに対応するCue/Summaryノートの期待パスを取得
            const expectedCuePath = this.getCueNotePath(file);
            const expectedSummaryPath = this.getSummaryNotePath(file);

            // 実際にファイルが存在するか確認
            const cueFile = this.app.vault.getAbstractFileByPath(expectedCuePath);
            const summaryFile = this.app.vault.getAbstractFileByPath(expectedSummaryPath);
            const actualCuePath = cueFile instanceof TFile ? cueFile.path : null;
            const actualSummaryPath = summaryFile instanceof TFile ? summaryFile.path : null;

            const currentInfo = this.noteInfoMap.get(sourcePath);
            if (currentInfo) {
                // 既存エントリ: Cue/Summaryパスが変更されていないか確認
                let infoNeedsUpdate = false;
                if (currentInfo.cuePath !== actualCuePath) {
                    currentInfo.cuePath = actualCuePath;
                    infoNeedsUpdate = true;
                }
                if (currentInfo.summaryPath !== actualSummaryPath) {
                    currentInfo.summaryPath = actualSummaryPath;
                    infoNeedsUpdate = true;
                }
                if (infoNeedsUpdate) {
                    updated++;
                    this.noteInfoMap.set(sourcePath, currentInfo); // 更新
                    mapChanged = true;
                }
                currentMapKeys.delete(sourcePath); // 処理済みとしてマーク
            } else {
                // 新規エントリ: マップに追加
                const newInfo: CornellNoteInfo = {
                    sourcePath,
                    cuePath: actualCuePath,
                    summaryPath: actualSummaryPath,
                    lastSyncSourceToCue: null, // 同期履歴は初期化
                    lastSyncCueToSource: null
                };
                this.noteInfoMap.set(sourcePath, newInfo);
                added++;
                mapChanged = true;
            }
        }));

        // マップに残っているキーはVaultから削除されたSourceノートに対応
        for (const deletedSourcePath of currentMapKeys) {
            if (this.noteInfoMap.delete(deletedSourcePath)) {
                removed++;
                mapChanged = true;
            }
        }

        console.log(`[Cornell FP] Note Info Map update: Added ${added}, Updated ${updated}, Removed ${removed}. Total: ${this.noteInfoMap.size}`);
        // マップが変更された場合のみ保存
        if (mapChanged) {
            await this.saveData();
            console.log("[Cornell FP] NoteInfoMap saved.");
        }
    }

	// --- イベントハンドラ ---
	/** ファイル変更イベントを処理し、自動同期をトリガー */
	private handleFileModifyForAutoSync = (file: TAbstractFile) => {
		// 自動同期が無効、または既に同期処理中の場合は何もしない
		if (!this.settings.syncOnSave || this.isSyncing) return;

		if (file instanceof TFile && file.extension === 'md') {
			if (!this.isCueNote(file.path) && !this.isSummaryNote(file.path)) {
                // Sourceノートが変更された -> S->C同期をDebounce付きで実行
                this.debouncedSyncSourceToCue(file);
			} else if (this.isCueNote(file.path)) {
                // Cueノートが変更された -> C->S同期をDebounce付きで実行
                this.debouncedSyncCueToSource(file);
			}
            // Summaryノートの変更は同期をトリガーしない
		}
	};

	// --- 手動同期ハンドラ ---
	/** 手動同期コマンドを処理 */
	private manualSyncHandler(view: MarkdownView, direction: 'S->C' | 'C->S', checking?: boolean): boolean | void {
		const file = view.file;
		if (!file) {
			if (!checking) new Notice('No active file.');
			return false; // ファイルがない場合は無効
		}

		if (direction === 'S->C') {
            // S->C同期はSourceノートからのみ実行可能
			if (this.isCueNote(file.path) || this.isSummaryNote(file.path)) {
				if (!checking) new Notice('Cannot run S->C sync from Cue/Summary note.');
				return false; // Cue/Summaryからは無効
			}
			if (!checking) { // コマンド実行時
				new Notice(`Manual Sync: S->C starting for ${file.basename}...`);
				this.syncSourceToCue(file)
					.then(() => new Notice(`Manual Sync: Cue updated for ${file.basename}.`))
					.catch(err => {
						console.error(`Manual Sync Error (S->C): ${file.path}`, err);
						new Notice('Sync Error (S->C). See console.');
					});
			}
            return true; // コマンドを有効にする
		} else if (direction === 'C->S') {
            // C->S同期はCueノートからのみ実行可能
			if (!this.isCueNote(file.path)) {
				if (!checking) new Notice('Can only run C->S sync from Cue note.');
				return false; // Cueノート以外からは無効
			}
			if (!checking) { // コマンド実行時
				new Notice(`Manual Sync: C->S starting from ${file.basename}...`);
				this.syncCueToSource(file)
					.then(() => {
                        // 成功したら対応するSourceノート名を表示
                        const sourceFile = this.getSourceNoteFileFromDerived(file.path);
                        new Notice(`Manual Sync: Source (${sourceFile?.basename ?? 'unknown'}) updated from ${file.basename}.`);
                    })
					.catch(err => {
						console.error(`Manual Sync Error (C->S): ${file.path}`, err);
						new Notice('Sync Error (C->S). See console.');
					});
			}
            return true; // コマンドを有効にする
		}
		return false; // 不明な方向
	}

	// --- コア同期ロジック ---

    /**
     * Source -> Cue 同期
     * Sourceノートの脚注定義のみを解析し、対応するCueノートに反映させる。
     * Cueノートの内容は、ヘッダー（Sourceへのリンク含む）、脚注定義、コードブロックのみで構成される。
     * Cueノートが存在しない場合はスキップする。
     * @param sourceNoteFile 同期元のSourceノートファイル
     */
    syncSourceToCue = async (sourceNoteFile: TFile): Promise<void> => {
        // 同期中の二重実行防止
        if (this.isSyncing) {
            console.log(`[S->C Sync] Skipped for ${sourceNoteFile.basename}: Already syncing.`);
            return;
        }
        if (this.isCueNote(sourceNoteFile.path) || this.isSummaryNote(sourceNoteFile.path)) {
            console.warn(`[S->C Sync] Invalid call: syncSourceToCue called with non-source note: ${sourceNoteFile.path}`);
            return;
        }

        this.isSyncing = true;
        const sourcePath = sourceNoteFile.path;
        let mapNeedsSave = false;

        console.log(`[S->C Sync] Starting for ${sourcePath}`);

        try {
            // 1. Sourceノートの脚注定義を解析
            const sourceContent = await this.app.vault.cachedRead(sourceNoteFile);
            // ここでは definitions のみが必要
            const { definitions: sourceDefs } = this.parseSourceContent(sourceContent);
            const sourceDefinitionsMap = new Map<string, string>(sourceDefs.map(def => [def.ref, def.definition]));

            // 2. 対応するCueノートの存在確認と現在の定義を取得
            const cueNotePath = this.getCueNotePath(sourceNoteFile);
            const cueFileAbstract = this.app.vault.getAbstractFileByPath(cueNotePath);
            let cueFileInstance: TFile | null = null;
            let currentCueContent = "";
            let cueFootnotesMap = new Map<string, string>();

            if (cueFileAbstract instanceof TFile) {
                cueFileInstance = cueFileAbstract;
                currentCueContent = await this.app.vault.cachedRead(cueFileInstance);
                cueFootnotesMap = this.parseFootnotesSimple(currentCueContent);
            } else {
                // Cueノートが存在しない場合、同期をスキップして終了
                new Notice(`Cue note for "${sourceNoteFile.basename}" not found at "${cueNotePath}". Skipping S->C sync.\nUse "Arrange Cornell Notes View" command to create it.`, 7000);
                console.log(`[S->C Sync] Cue note not found for ${sourcePath} at ${cueNotePath}. Skipping.`);
                const info = this.getOrCreateNoteInfo(sourceNoteFile);
                if (info.cuePath !== null) {
                    info.cuePath = null;
                    this.noteInfoMap.set(sourcePath, info);
                    await this.saveData();
                }
                this.isSyncing = false;
                await sleep(INTERNAL_SETTINGS.syncFlagReleaseDelay);
                return;
            }

            // 3. Sourceの定義に基づいて、最終的なCueノートの定義マップを作成
            //    (Sourceに存在しない定義はCueから削除、Sourceの内容でCueを上書き)
            const finalCueFootnotes = new Map<string, string>();
            const sourceDefRefs = new Set(sourceDefinitionsMap.keys());
            let definitionsChanged = false;

            // Sourceの定義をコピー
            for(const [ref, def] of sourceDefinitionsMap.entries()) {
                finalCueFootnotes.set(ref, def);
                if (!cueFootnotesMap.has(ref) || cueFootnotesMap.get(ref)?.trim() !== def.trim()) {
                    definitionsChanged = true;
                }
            }
            // Cueにのみ存在する定義をチェック（削除されたかどうかの判定）
            for(const ref of cueFootnotesMap.keys()){
                if(!sourceDefRefs.has(ref)){
                    definitionsChanged = true; // 削除も変更とみなす
                }
            }
            // オプション: Sourceから参照がすべて削除された定義をCueからも削除
            if (this.settings.deleteDefinitionsOnReferenceDelete) {
                const { references: sourceRefs } = this.parseSourceContent(sourceContent); // 参照も解析
                const presentSourceRefKeys = new Set(sourceRefs.map(r => r.ref));
                for (const [ref] of finalCueFootnotes.entries()) { // finalCueFootnotesを使う
                    if (!presentSourceRefKeys.has(ref)) {
                        if(finalCueFootnotes.delete(ref)){
                             console.log(`[S->C Sync] Deleting def [^${ref}] from Cue (no refs in Source & setting enabled).`);
                            definitionsChanged = true;
                        }
                    }
                }
            }


            if (definitionsChanged) {
                 console.log(`[S->C Sync] Definitions changed for ${sourcePath}. Updating Cue note.`);
            } else {
                 console.log(`[S->C Sync] No definition changes detected for ${sourcePath}. Checking structure.`);
            }

            // 4. Cueノートの期待される内容を生成 (ヘッダー、最終定義、コードブロック)
            //    generateCueContent 内で現在の内容と比較し、構造（ヘッダーやコードブロックの有無）もチェック
            const updated = await this.updateCueNoteContent(cueFileInstance, sourceNoteFile, finalCueFootnotes);

            if (updated) {
                 console.log(`[S->C Sync] Cue note ${cueFileInstance.path} updated.`);
                 mapNeedsSave = true; // NoteInfoMapの同期時刻を更新するため
            } else {
                 console.log(`[S->C Sync] Cue note ${cueFileInstance.path} content is already up-to-date.`);
            }

            // 5. NoteInfoMapを更新 (同期時刻、Cueパス)
            const info = this.getOrCreateNoteInfo(sourceNoteFile);
            let infoChanged = false;
            if (info.cuePath !== cueFileInstance.path) {
                info.cuePath = cueFileInstance.path;
                infoChanged = true;
            }
            if (mapNeedsSave) { // 実際に更新があった場合のみ時刻更新
                info.lastSyncSourceToCue = Date.now();
                infoChanged = true;
            }
            if (infoChanged) {
                this.noteInfoMap.set(sourcePath, info);
                await this.saveData();
            }

        } catch (error) {
            console.error(`[S->C Sync] Error during sync for ${sourceNoteFile?.basename}:`, error);
            new Notice(`Error during S->C sync for ${sourceNoteFile.basename}. See console.`);
        } finally {
            await sleep(INTERNAL_SETTINGS.syncFlagReleaseDelay);
            this.isSyncing = false;
             console.log(`[S->C Sync] Finished for ${sourceNoteFile.path}`);
        }
	}

    /**
     * Cue -> Source 同期
     * Cueノートの脚注定義を解析し、対応するSourceノートに反映させる。
     * Sourceノートの脚注定義ブロックは、設定に応じて末尾に移動される。
     * @param cueNoteFile 同期元のCueノートファイル
     */
    async syncCueToSource(cueNoteFile: TFile): Promise<void> {
        // 同期中の二重実行防止
        if (this.isSyncing) {
            console.log(`[C->S Sync] Skipped for ${cueNoteFile.basename}: Already syncing.`);
            return;
        }
        if (!this.isCueNote(cueNoteFile.path)) {
             console.warn(`[C->S Sync] Invalid call: syncCueToSource called with non-cue note: ${cueNoteFile.path}`);
             return;
        }

        this.isSyncing = true;
        let sourceNoteFile: TFile | null = null;
        let mapNeedsSave = false;

        console.log(`[C->S Sync] Starting from ${cueNoteFile.path}`);

        try {
            // 1. Cueノートの脚注定義を解析
            const cueContent = await this.app.vault.cachedRead(cueNoteFile);
            const footnotesFromCue = this.parseFootnotesSimple(cueContent);

            // 2. 対応するSourceノートを特定
            sourceNoteFile = this.getSourceNoteFileFromDerived(cueNoteFile.path);
            if (!sourceNoteFile) {
                new Notice(`Source note not found for ${cueNoteFile.basename}. Cannot sync C->S.`);
                console.error(`[C->S Sync] Source note not found for cue note: ${cueNoteFile.path}`);
                this.isSyncing = false;
                return;
            }
            const sourcePath = sourceNoteFile.path;
            console.log(`[C->S Sync] Target Source note: ${sourcePath}`);

            // 3. Sourceノートの現在の内容を読み込む
            const sourceContent = await this.app.vault.cachedRead(sourceNoteFile);

            // 4. Sourceノートの新しい内容を生成 (Cueの定義を反映し、オプションで脚注移動/参照削除)
            const newSourceContent = this.updateSourceNoteContentRebuild(
                sourceContent,
                footnotesFromCue,
                this.settings.deleteReferencesOnDefinitionDelete,
                this.settings.moveFootnotesToEnd
            );

            // 5. Sourceノートの内容に変更があれば書き込み
            if (newSourceContent !== sourceContent) {
                 console.log(`[C->S Sync] Source note ${sourcePath} needs update.`);
                await this.app.vault.modify(sourceNoteFile, newSourceContent);
                mapNeedsSave = true; // NoteInfoMapの同期時刻を更新するため
                 console.log(`[C->S Sync] Source note ${sourcePath} updated.`);
            } else {
                 console.log(`[C->S Sync] Source note ${sourcePath} content is already up-to-date.`);
            }

            // 6. NoteInfoMapを更新 (同期時刻、Cueパス)
            const info = this.getOrCreateNoteInfo(sourceNoteFile);
            let infoChanged = false;
            if (info.cuePath !== cueNoteFile.path) {
                info.cuePath = cueNoteFile.path;
                infoChanged = true;
            }
            if (mapNeedsSave) { // 実際に更新があった場合のみ時刻更新
                info.lastSyncCueToSource = Date.now();
                infoChanged = true;
            }
            if (infoChanged) {
                this.noteInfoMap.set(sourcePath, info);
                await this.saveData();
            }

        } catch (error) {
            console.error(`[C->S Sync] Error during sync from '${cueNoteFile.basename}':`, error);
            new Notice(`Error C->S sync for ${cueNoteFile.basename}. See console.`);
        } finally {
            await sleep(INTERNAL_SETTINGS.syncFlagReleaseDelay);
            this.isSyncing = false;
             console.log(`[C->S Sync] Finished for ${cueNoteFile.path}`);
        }
    }

	// --- ヘルパー関数 ---

	/** Sourceノートファイルに対応するNoteInfoを取得、なければ作成して返す */
	getOrCreateNoteInfo(sourceNoteFile: TFile): CornellNoteInfo {
        const sourcePath = sourceNoteFile.path;
        let info = this.noteInfoMap.get(sourcePath);
        if (!info) {
            // マップにない場合は新規作成
            const cuePath = this.getCueNotePath(sourceNoteFile);
            const summaryPath = this.getSummaryNotePath(sourceNoteFile);
            const cueFile = this.app.vault.getAbstractFileByPath(cuePath);
            const summaryFile = this.app.vault.getAbstractFileByPath(summaryPath);
            info = {
                sourcePath,
                cuePath: cueFile instanceof TFile ? cueFile.path : null,
                summaryPath: summaryFile instanceof TFile ? summaryFile.path : null,
                lastSyncSourceToCue: null,
                lastSyncCueToSource: null
            };
            this.noteInfoMap.set(sourcePath, info);
             console.log(`[Util] Created new NoteInfo entry for ${sourcePath}`);
        }
        return info;
    }

	/** Markdownコンテンツから脚注定義と参照を解析 */
	parseSourceContent(content: string): { definitions: ParsedDefinition[], references: ParsedReference[] } {
		const definitions: ParsedDefinition[] = [];
		const references: ParsedReference[] = [];

        // 脚注定義の正規表現: 行頭(空白許容)から始まり、複数行定義に対応
        const defRegex = /^(\s*)\[\^([^\]]+?)\]:\s*(.*(?:(?:\n(?:\ {4}|\t|\s{2,}).*)*))/gm;
        let match;
		while ((match = defRegex.exec(content)) !== null) {
            definitions.push({
                ref: match[2].trim(), // 参照名
                // 複数行定義のインデントを除去して結合
                definition: match[3].replace(/\n(?: {4}|\t|\s{2,})/g, '\n').trim(),
                start: match.index, // マッチ開始位置
                end: match.index + match[0].length, // マッチ終了位置
                fullMatch: match[0] // マッチした文字列全体
            });
        }

		// 脚注参照の正規表現: `[^ref]` の形式で、後ろに `:` が続かないもの (定義と区別)
        const refRegex = /\[\^([^\]]+?)\](?!:)/g;
		while ((match = refRegex.exec(content)) !== null) {
            references.push({
                ref: match[1].trim(), // 参照名
                start: match.index,
                end: match.index + match[0].length,
                fullMatch: match[0]
            });
        }
		return { definitions, references };
	}

    /**
     * Sourceノートの内容を、Cueノートから取得した脚注定義に基づいて更新する（C->S同期用）。
     * オプションで脚注定義をノートの末尾に移動させる。
     * @param sourceContent 元のSourceノートのコンテンツ文字列
     * @param footnotesFromCue Cueノートから解析された脚注定義 (Map<ref, definition>)
     * @param deleteReferences Cueに存在しない定義に対応するSource内の参照 ([^ref]) も削除するかどうか
     * @param moveToEnd 脚注定義ブロック全体をノートの末尾に移動させるか
     * @returns 更新されたSourceノートのコンテンツ文字列
     */
	updateSourceNoteContentRebuild(sourceContent: string, footnotesFromCue: Map<string, string>, deleteReferences: boolean, moveToEnd: boolean): string {
		// 1. 元のSourceノートの内容を解析
        const { definitions: sourceDefs } = this.parseSourceContent(sourceContent); // references はここでは不要
        const refsDefinedInCue = new Set(footnotesFromCue.keys()); // Cueに存在する定義のrefセット
        const refsToDeleteCompletely = new Set<string>(); // Cueに定義がなく、Sourceからも完全に削除すべきref

        // 2. 最終的にSourceに残すべき定義マップを作成 (Cueの内容を正とする)
        const finalDefinitions = new Map<string, string>();
        // Sourceに元々あった定義をチェック
        for (const def of sourceDefs) {
            if (refsDefinedInCue.has(def.ref)) {
                // Cueにも存在する -> Cueの内容で更新
                finalDefinitions.set(def.ref, footnotesFromCue.get(def.ref)!);
            } else {
                // Cueに存在しない -> この定義はSourceから削除する
                refsToDeleteCompletely.add(def.ref);
                 console.log(`[C->S Rebuild] Marking def [^${def.ref}] for deletion (not in Cue).`);
            }
        }
        // Cueには存在するがSourceには元々なかった定義を追加
        for(const [cueRef, cueDef] of footnotesFromCue.entries()) {
            if(!sourceDefs.some(d => d.ref === cueRef)) {
                 console.log(`[C->S Rebuild] Adding new def [^${cueRef}] from Cue.`);
                finalDefinitions.set(cueRef, cueDef);
            }
        }

        // 3. 本文内容の処理
        let bodyContent = sourceContent; // 元のコンテンツから開始

        // 3a. すべての既存の脚注定義を元のコンテンツから削除
        const sortedDefsToRemove = [...sourceDefs].sort((a, b) => b.start - a.start); // 後ろから削除
        for (const def of sortedDefsToRemove) {
            bodyContent = bodyContent.slice(0, def.start) + bodyContent.slice(def.end);
        }
        bodyContent = bodyContent.trimEnd(); // 末尾の余分な空白や改行を除去

        // 3b. オプション: 不要な参照を本文から削除
        if (deleteReferences && refsToDeleteCompletely.size > 0) {
             console.log(`[C->S Rebuild] Removing references for deleted definitions: ${Array.from(refsToDeleteCompletely).join(', ')}`);
            // 削除対象のrefに一致する参照 [^ref] を空文字に置換
            const refsToDeleteRegex = new RegExp(`\\[\\^(${Array.from(refsToDeleteCompletely).map(this.escapeRegex).join('|')})\\](?!:)`, 'g');
            bodyContent = bodyContent.replace(refsToDeleteRegex, '');
        }

        // 4. 新しい脚注定義ブロックを生成 (ソートして整形)
        let finalDefinitionsText = "";
        if (finalDefinitions.size > 0) {
             finalDefinitionsText = Array.from(finalDefinitions.entries())
                .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: 'base' }))
                .map(([ref, def]) => `[^${ref}]: ${def}`)
                .join('\n\n');
        }

        // 5. 本文と定義ブロックを結合
        let newSourceContent = bodyContent; // 更新された本文
        if (finalDefinitionsText) {
            if (moveToEnd) {
                // 末尾に移動する場合
                newSourceContent += '\n\n' + finalDefinitionsText;
            } else {
                // 元の位置に戻す場合 (現状は末尾に追加)
                console.warn("[Cornell FP] moveFootnotesToEnd=false: Footnotes will still be appended to the end in C->S sync.");
                newSourceContent += '\n\n' + finalDefinitionsText;
            }
        }
        newSourceContent = newSourceContent.trimEnd() + '\n'; // 末尾を整形して改行を追加

		// 連続する3つ以上の改行を2つにまとめる (整形)
		return newSourceContent.replace(/\n{3,}/g, '\n\n');
	}

    /**
     * Cueノートの期待される内容を生成 (ヘッダー、脚注定義、コードブロックのみ)。
     * @param currentContent 現在のCueノートの内容（ヘッダー抽出用）
     * @param sourceNoteFile 対応するSourceノートファイル（リンク生成用）
     * @param footnotes Cueノートに含めるべき脚注定義 (Map<ref, definition>)
     * @returns 生成されたCueノートのコンテンツ文字列
     */
    private generateCueContent(currentContent: string, sourceNoteFile: TFile, footnotes: Map<string, string>): string {
        const linkToSource = this.settings.linkToSourceText.replace('{{sourceNote}}', sourceNoteFile.basename);
        let header = "";

        // 最初の脚注定義行 または コードブロック開始行 を探す
        const firstDefMatch = currentContent.match(/^(\s*\[\^.+?\]:)/m);
        const firstCbMatch = currentContent.match(new RegExp("^\\s*```" + INTERNAL_SETTINGS.codeBlockProcessorId, "m")); // 行頭からチェック

        let firstElementIdx = currentContent.length; // デフォルトは末尾
        if (firstDefMatch?.index !== undefined) {
            firstElementIdx = firstDefMatch.index;
        }
        if (firstCbMatch?.index !== undefined && firstCbMatch.index < firstElementIdx) {
            firstElementIdx = firstCbMatch.index;
        }

        // 最初の要素（定義orコードブロック）より前の部分をヘッダーとして抽出
        let extractedHeader = currentContent.substring(0, firstElementIdx).trimEnd();

        // ヘッダーにSourceへのリンクが含まれていない場合は追加
        if (!extractedHeader.includes(linkToSource)) {
             extractedHeader = extractedHeader ? `${linkToSource}\n\n${extractedHeader}` : linkToSource;
         }

        // ヘッダー部分の準備完了
        let finalHeader = extractedHeader ? extractedHeader + '\n\n' : '';

        // 脚注定義部分を生成 (引数の footnotes Map から)
        let fnsText = "";
        if (footnotes.size > 0) {
            fnsText = Array.from(footnotes.entries())
                .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: 'base' }))
                .map(([ref, def]) => `[^${ref}]: ${def}`)
                .join('\n\n'); // 定義間は空行
        }

        // カスタムコードブロック部分を生成 (脚注が1つ以上ある場合のみ)
        let codeBlockSection = "";
        if (footnotes.size > 0) {
            codeBlockSection = `\n\n\`\`\`${INTERNAL_SETTINGS.codeBlockProcessorId}\n\`\`\`\n`;
        }

        // 全体を結合 (ヘッダー + 脚注定義 + コードブロック)
        // これにより、元のCueノートにあった定義やコードブロック以外のテキストは除去される
        const newContent = (finalHeader + fnsText + codeBlockSection).trimEnd() + '\n';
        // 連続する3つ以上の改行を2つにまとめる
        return newContent.replace(/\n{3,}/g, '\n\n');
    }


	/** Cueノートの内容を更新 (必要であれば) */
	async updateCueNoteContent(cueNoteFile: TFile, sourceNoteFile: TFile, footnotes: Map<string, string>): Promise<boolean> {
        let updated = false;
		try {
            // 現在のCueノートの内容を取得
            const currentContent = await this.app.vault.cachedRead(cueNoteFile);
            // 期待されるCueノートの内容を生成 (ヘッダー、指定された脚注、コードブロック)
            const newContent = this.generateCueContent(currentContent, sourceNoteFile, footnotes);

            // 内容が異なる場合のみ書き込み
            if (currentContent !== newContent) {
                 console.log(`[Util] Updating content of Cue note: ${cueNoteFile.path}`);
                await this.app.vault.modify(cueNoteFile, newContent);
                updated = true;
            } else {
                 // console.log(`[Util] Cue note content is already up-to-date: ${cueNoteFile.path}`);
            }
		} catch (error) {
            console.error(`[Util] Error updating Cue note content for '${cueNoteFile.basename}':`, error);
        }
        return updated; // 更新したかどうかを返す
	}

    /** Markdownコンテンツから脚注定義のみを簡易的に解析 (Map<ref, definition>) */
	parseFootnotesSimple = (content: string): Map<string, string> => {
        const footnotesMap = new Map<string, string>();
        const regex = /^(\s*)\[\^([^\]]+?)\]:\s*(.*(?:(?:\n(?:\ {4}|\t|\s{2,}).*)*))/gm;
        let match;
        while ((match = regex.exec(content)) !== null) {
            if(match[2]) { // 参照名がある場合のみ
                const ref = match[2].trim();
                const definition = match[3].replace(/\n(?: {4}|\t|\s{2,})/g, '\n').trim();
                footnotesMap.set(ref, definition);
            }
        }
        return footnotesMap;
    }

	/** ファイルパスがCueノートか判定 */
	isCueNote = (filePath: string): boolean => {
        return filePath ? normalizePath(filePath).endsWith(INTERNAL_SETTINGS.cueNoteSuffix + '.md') : false;
    }

	/** ファイルパスがSummaryノートか判定 */
	isSummaryNote = (filePath: string): boolean => {
        return filePath ? normalizePath(filePath).endsWith(INTERNAL_SETTINGS.summaryNoteSuffix + '.md') : false;
    }

	/** Sourceノートファイルに対応するCueノートの期待パスを生成 */
	getCueNotePath = (sourceFile: TFile): string => {
        const basename = sourceFile.basename;
        const cueFilename = `${basename}${INTERNAL_SETTINGS.cueNoteSuffix}.md`;
        // 基本的にSourceと同じフォルダに作成
        const folderPath = sourceFile.parent?.path ?? '/';
        const finalPath = (folderPath === '/' || folderPath === '') ? cueFilename : `${folderPath}/${cueFilename}`;
        return normalizePath(finalPath);
    }

	/** Sourceノートファイルに対応するSummaryノートの期待パスを生成 */
	getSummaryNotePath = (sourceFile: TFile): string => {
        const basename = sourceFile.basename;
        const summaryFilename = `${basename}${INTERNAL_SETTINGS.summaryNoteSuffix}.md`;
        // 基本的にSourceと同じフォルダに作成
        const folderPath = sourceFile.parent?.path ?? '/';
        const finalPath = (folderPath === '/' || folderPath === '') ? summaryFilename : `${folderPath}/${summaryFilename}`;
        return normalizePath(finalPath);
    }

	/** CueまたはSummaryノートのパスから、対応するSourceノートファイルを取得 */
	getSourceNoteFileFromDerived = (derivedPath: string): TFile | null => {
        const normalizedDerivedPath = normalizePath(derivedPath);

        // 1. NoteInfoMapから逆引き試行 (最も確実)
        for (const info of this.noteInfoMap.values()) {
            if (info.cuePath === normalizedDerivedPath || info.summaryPath === normalizedDerivedPath) {
                const sourceFile = this.app.vault.getAbstractFileByPath(info.sourcePath);
                if (sourceFile instanceof TFile) {
                    return sourceFile;
                }
            }
        }

        // 2. Mapにない場合、パスから推測 (フォールバック)
        let sourceBasename: string | null = null;
        const derivedFilename = normalizedDerivedPath.split('/').pop() ?? '';
        const derivedFolder = normalizedDerivedPath.substring(0, normalizedDerivedPath.lastIndexOf('/')) || '/';

        // ファイル名からサフィックスを除去してSourceのベース名を取得
        if (this.isCueNote(normalizedDerivedPath)) {
            sourceBasename = derivedFilename.replace(new RegExp(this.escapeRegex(INTERNAL_SETTINGS.cueNoteSuffix + '.md')+'$'), '');
        } else if (this.isSummaryNote(normalizedDerivedPath)) {
            sourceBasename = derivedFilename.replace(new RegExp(this.escapeRegex(INTERNAL_SETTINGS.summaryNoteSuffix + '.md')+'$'), '');
        }

        if (!sourceBasename) {
            // console.warn(`[Util] Could not determine source basename from derived path: ${derivedPath}`);
            return null; // ベース名が特定できなければ失敗
        }

        const sourceFilename = `${sourceBasename}.md`;
        // 検索候補パスリストを作成 (同じフォルダ、親フォルダ、ルート)
        const potentialPaths: string[] = [];
        potentialPaths.push(normalizePath(`${derivedFolder}/${sourceFilename}`));
		if (derivedFolder !== '/') {
            const parentFolder = derivedFolder.substring(0, derivedFolder.lastIndexOf('/')) || '/';
            potentialPaths.push(normalizePath(`${parentFolder}/${sourceFilename}`));
            potentialPaths.push(normalizePath(`/${sourceFilename}`));
        }
        const uniquePaths = [...new Set(potentialPaths)];

        // 候補パスを順に検索
        for (const p of uniquePaths) {
            const file = this.app.vault.getAbstractFileByPath(p);
            // ファイルが存在し、ベース名が一致するか確認
            if (file instanceof TFile && file.basename === sourceBasename) {
                 console.log(`[Util] Guessed Source note for ${derivedPath} -> ${file.path}`);
                // 見つかったらNoteInfoMapを更新しておく
                let info = this.noteInfoMap.get(file.path);
                if (!info) {
                    info = { sourcePath: file.path, cuePath: null, summaryPath: null, lastSyncSourceToCue: null, lastSyncCueToSource: null };
                }
                if (this.isCueNote(normalizedDerivedPath)) info.cuePath = normalizedDerivedPath;
                if (this.isSummaryNote(normalizedDerivedPath)) info.summaryPath = normalizedDerivedPath;
                this.noteInfoMap.set(file.path, info);
                this.saveData().catch(e => console.error("[Util] Error saving NoteInfoMap after guessing source:", e));
                return file;
            }
        }

         console.warn(`[Util] Source note file not found for derived path: ${derivedPath} (tried paths: ${uniquePaths.join(', ')})`);
		return null; // 見つからなかった場合
	}

    /** 指定されたフォルダパスが存在することを確認、なければ作成 */
    async ensureFolderExists(folderPath: string): Promise<void> {
        const normalizedPath = normalizePath(folderPath);
        if (!normalizedPath || normalizedPath === '/') return;
        try {
            const folder = this.app.vault.getAbstractFileByPath(normalizedPath);
            if (!folder) {
                 console.log(`[Util] Creating folder: ${normalizedPath}`);
                await this.app.vault.createFolder(normalizedPath);
            } else if (!(folder instanceof TFolder)) {
                throw new Error(`Path exists but is not a folder: ${normalizedPath}`);
            }
        } catch (e: any) {
            if (!(e?.message?.includes('already exists'))) {
                console.error(`[Util] Error ensuring folder exists '${normalizedPath}':`, e);
                throw e;
            }
        }
    }

	/** 正規表現用に文字列をエスケープ */
	escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    /** 指定されたファイルを開いているLeafを探す */
    findLeafForFile = (file: TFile): WorkspaceLeaf | null => {
        let targetLeaf: WorkspaceLeaf | null = null;
        this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
            if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) {
                targetLeaf = leaf;
            }
        });
        return targetLeaf;
    }

    /** Cueノートが存在することを確認し、なければ作成する (Arrangeコマンド用) */
    async ensureCueNoteExists(cuePath: string, sourceFile: TFile): Promise<TFile | null> {
        try {
            let abstractFile = this.app.vault.getAbstractFileByPath(cuePath);
            if (abstractFile instanceof TFile) {
                return abstractFile; // 既に存在すればそれを返す
            }
            if (abstractFile) {
                throw new Error(`Path exists but is not a file: ${cuePath}`);
            }

            console.log(`[Util] Cue note does not exist, creating for Arrange View: ${cuePath}`);
            const parentFolder = cuePath.substring(0, cuePath.lastIndexOf('/')) || '/';
            await this.ensureFolderExists(parentFolder);

            // 初期コンテンツ (Sourceへのリンクと空のコードブロック)
            const sourceLink = this.settings.linkToSourceText.replace('{{sourceNote}}', sourceFile.basename);
            // S->C Sync時に定義とコードブロックは自動生成されるので、ここではリンクだけで良いかも
            const initialContent = `${sourceLink}\n\n`;
            // const initialContent = `${sourceLink}\n\n\`\`\`${INTERNAL_SETTINGS.codeBlockProcessorId}\n\`\`\`\n`;

            abstractFile = await this.app.vault.create(cuePath, initialContent);
            if (!(abstractFile instanceof TFile)) {
                throw new Error(`Failed to create cue note file: ${cuePath}`);
            }

            // NoteInfoMap を更新
            const info = this.getOrCreateNoteInfo(sourceFile);
            if (info.cuePath !== abstractFile.path) {
                info.cuePath = abstractFile.path;
                this.noteInfoMap.set(sourceFile.path, info);
                await this.saveData(); // 保存
            }
            // 新規作成後、最初のS->C同期をトリガーしても良いかもしれない
            // await this.syncSourceToCue(sourceFile); // ここで呼ぶと Arrange 中に同期が走る

            return abstractFile;

        } catch (e) {
            console.error(`[Util] Error ensuring Cue note exists at '${cuePath}':`, e);
            new Notice(`Error creating Cue note at ${cuePath}. See console.`);
            return null;
        }
    }

	/** Summaryノートが存在することを確認し、なければ作成する (Arrangeコマンド用) */
	async ensureSummaryNoteExists(summaryPath: string, sourceFile: TFile, cueFile: TFile): Promise<TFile | null> {
        try {
            let abstractFile = this.app.vault.getAbstractFileByPath(summaryPath);
            if (abstractFile instanceof TFile) {
                return abstractFile;
            }
            if (abstractFile) {
                throw new Error(`Path exists but is not a file: ${summaryPath}`);
            }

            console.log(`[Util] Summary note does not exist, creating for Arrange View: ${summaryPath}`);
            const parentFolder = summaryPath.substring(0, summaryPath.lastIndexOf('/')) || '/';
            await this.ensureFolderExists(parentFolder);

            // 初期コンテンツ (SourceとCueへのリンク、Summaryセクション)
            const sourceLink = this.settings.linkToSourceText.replace('{{sourceNote}}', sourceFile.basename);
            const cueLink = this.settings.linkToCueText.replace('{{cueNote}}', cueFile.basename);
            const initialContent = `${sourceLink}\n${cueLink}\n\n# Summary\n\n`;

            abstractFile = await this.app.vault.create(summaryPath, initialContent);
            if (!(abstractFile instanceof TFile)) {
                throw new Error(`Failed to create summary note file: ${summaryPath}`);
            }

            // NoteInfoMap を更新
            const info = this.getOrCreateNoteInfo(sourceFile);
            if (info.summaryPath !== abstractFile.path) {
                info.summaryPath = abstractFile.path;
                this.noteInfoMap.set(sourceFile.path, info);
                await this.saveData(); // 保存
            }
            return abstractFile;

        } catch (e) {
            console.error(`[Util] Error ensuring Summary note exists at '${summaryPath}':`, e);
             new Notice(`Error creating Summary note at ${summaryPath}. See console.`);
            return null;
        }
    }

    /** Cornell Notes View を配置する */
    async arrangeCornellNotesView(sourceFile: TFile, sourceLeaf: WorkspaceLeaf): Promise<void> {
        try {
            console.log(`[Arrange] Starting for ${sourceFile.path}`);
            // 1. Cueノートの準備（存在確認＆なければ作成）
            const cuePath = this.getCueNotePath(sourceFile);
            const cueFile = await this.ensureCueNoteExists(cuePath, sourceFile);
            if (!cueFile) {
                throw new Error(`Failed to get or create Cue note: ${cuePath}`);
            }

            // 2. Summaryノートの準備（存在確認＆なければ作成）
            const summaryPath = this.getSummaryNotePath(sourceFile);
            const summaryFile = await this.ensureSummaryNoteExists(summaryPath, sourceFile, cueFile);
            if (!summaryFile) {
                console.warn(`[Arrange] Could not get or create Summary note at ${summaryPath}. Proceeding without Summary view.`);
                new Notice(`Could not open or create Summary note. Arranging Source and Cue only.`);
            }

            // *** ここで最初のS->C同期を実行してCueノートを初期化する ***
            console.log(`[Arrange] Running initial S->C sync for ${sourceFile.basename} -> ${cueFile.basename}`);
            await this.syncSourceToCue(sourceFile);

            // 3. Leafの準備とファイルオープン
            let cueLeaf: WorkspaceLeaf | null = this.findLeafForFile(cueFile);
            let summaryLeaf: WorkspaceLeaf | null = summaryFile ? this.findLeafForFile(summaryFile) : null;

            // Cue Leafの処理
            if (!cueLeaf) {
                 console.log(`[Arrange] Creating new leaf for Cue note: ${cueFile.path}`);
                cueLeaf = this.app.workspace.createLeafBySplit(sourceLeaf, 'vertical', false); // 右側に分割
                await cueLeaf.openFile(cueFile, { active: false });
            } else {
                 console.log(`[Arrange] Found existing leaf for Cue note: ${cueFile.path}`);
                 // 必要ならファイルを再読み込みさせるために再度開く
                await this.openFileInLeaf(cueLeaf, cueFile, false);
            }

            // Summary Leafの処理 (Summaryファイルが存在する場合のみ)
            if (summaryFile) {
                if (!summaryLeaf) {
                     console.log(`[Arrange] Creating new leaf for Summary note: ${summaryFile.path}`);
                    summaryLeaf = this.app.workspace.createLeafBySplit(sourceLeaf, 'horizontal', false); // 下側に分割
                    await summaryLeaf.openFile(summaryFile, { active: false });
                } else {
                    console.log(`[Arrange] Found existing leaf for Summary note: ${summaryFile.path}`);
                    await this.openFileInLeaf(summaryLeaf, summaryFile, false);
                }
            }

            // 4. 最後にSource Leafをアクティブにする
             console.log(`[Arrange] Activating Source leaf: ${sourceFile.path}`);
            this.app.workspace.setActiveLeaf(sourceLeaf, { focus: true });
            console.log(`[Arrange] Finished arranging view for ${sourceFile.basename}.`);

        } catch (e) {
            console.error(`[Arrange] Error arranging Cornell notes view for ${sourceFile.basename}:`, e);
            new Notice(`Error arranging view for ${sourceFile.basename}. See console.`);
        }
    }

    /** CueノートからSourceノートの対応する脚注参照へ移動 */
	async navigateToSourceReference(ref: string, cuePath: string): Promise<void> { // targetLineNumber は削除
        console.log(`[Navigate] Request to navigate to ref [^${ref}] from ${cuePath}`);
        const sourceFile = this.getSourceNoteFileFromDerived(cuePath);
        if (!sourceFile) {
            new Notice(`Source note not found for "${cuePath}". Cannot navigate.`);
            throw new Error(`Source note not found for cue: ${cuePath}`);
        }

        let sourceLeaf = this.findLeafForFile(sourceFile);
        if (!sourceLeaf) {
            new Notice(`Source note "${sourceFile.basename}" is not open. Opening...`);
            try {
                sourceLeaf = this.app.workspace.getLeaf('tab');
                await sourceLeaf.openFile(sourceFile, { active: true });
                this.app.workspace.setActiveLeaf(sourceLeaf, {focus: true});
                await sleep(INTERNAL_SETTINGS.uiUpdateDelay * 2);
                if (!(sourceLeaf?.view instanceof MarkdownView)) throw new Error("Opened file is not a Markdown view.");
                 console.log(`[Navigate] Opened Source note ${sourceFile.path} in new leaf.`);
            } catch (e) {
                console.error(`[Navigate] Error auto-opening source note ${sourceFile.path}:`, e);
                new Notice(`Failed to open source note "${sourceFile.basename}".`);
                throw e;
            }
        } else {
            if (this.app.workspace.activeLeaf !== sourceLeaf) {
                 console.log(`[Navigate] Activating existing leaf for Source note ${sourceFile.path}`);
                this.app.workspace.setActiveLeaf(sourceLeaf, { focus: true });
                await sleep(INTERNAL_SETTINGS.uiUpdateDelay / 2);
            }
        }

        if (!sourceLeaf || !(sourceLeaf.view instanceof MarkdownView)) {
            new Notice(`Cannot access source view for "${sourceFile.basename}".`);
            throw new Error("Source view not accessible after opening/finding leaf.");
        }
        const sourceView = sourceLeaf.view as MarkdownView;
        const sourceEditor = sourceView.editor;
        const sourceContent = sourceEditor.getValue();
        const refRegex = new RegExp(`\\[\\^${this.escapeRegex(ref)}\\](?!:)`);
        const match = sourceContent.match(refRegex);

        if (match?.index !== undefined) {
            const matchIndex = match.index;
            const startPos = sourceEditor.offsetToPos(matchIndex);
            const endPos = sourceEditor.offsetToPos(matchIndex + match[0].length);
             console.log(`[Navigate] Found ref [^${ref}] at line ${startPos.line + 1}, char ${startPos.ch}`);
            sourceEditor.scrollIntoView({ from: startPos, to: endPos }, true);
            this.clearActiveHighlight();
            sourceEditor.setSelection(startPos, endPos);
            this.activeHighlightTimeout = setTimeout(() => {
                const currentSelection = sourceEditor.listSelections()[0];
                if (currentSelection && this.app.workspace.activeEditor?.editor === sourceEditor &&
                    this.arePositionsEqual(currentSelection.anchor, startPos) &&
                    this.arePositionsEqual(currentSelection.head, endPos)) {
                    sourceEditor.setCursor(startPos);
                }
                this.activeHighlightTimeout = null;
            }, INTERNAL_SETTINGS.highlightDuration);
        } else {
             console.log(`[Navigate] Ref [^${ref}] not found in ${sourceFile.path}.`);
            new Notice(`Reference [^${ref}] not found in "${sourceFile.basename}".`);
            sourceEditor.setCursor({line: 0, ch: 0});
            sourceEditor.scrollTo(0, 0);
        }
        sourceEditor.focus();
    }

    /** CueノートからSourceノートの対応する脚注参照をハイライト表示 */
    async highlightFirstSourceReference(ref: string, cuePath: string): Promise<void> {
        console.log(`[Highlight] Request to highlight ref [^${ref}] from ${cuePath}`);
        const sourceFile = this.getSourceNoteFileFromDerived(cuePath);
        if (!sourceFile) {
            new Notice(`Source note not found for "${cuePath}". Cannot highlight.`);
            throw new Error(`Source note not found for cue: ${cuePath}`);
        }

        let sourceLeaf = this.findLeafForFile(sourceFile);
        if (!sourceLeaf) {
            new Notice(`Source note "${sourceFile.basename}" is not open. Opening in background...`);
            try {
                sourceLeaf = this.app.workspace.getLeaf('tab');
                await sourceLeaf.openFile(sourceFile, { active: false });
                await sleep(INTERNAL_SETTINGS.uiUpdateDelay);
                if (!(sourceLeaf?.view instanceof MarkdownView)) throw new Error("Opened file is not a Markdown view.");
                 console.log(`[Highlight] Opened Source note ${sourceFile.path} in background leaf.`);
            } catch (e) {
                console.error(`[Highlight] Error opening source note ${sourceFile.path} in background:`, e);
                new Notice(`Failed to open source note "${sourceFile.basename}" for highlighting.`);
                throw e;
            }
        } else {
             console.log(`[Highlight] Found existing leaf for Source note ${sourceFile.path}`);
        }

        if (!sourceLeaf || !(sourceLeaf.view instanceof MarkdownView)) {
            new Notice(`Cannot access source view for "${sourceFile.basename}".`);
            throw new Error("Source view not accessible.");
        }
        const sourceView = sourceLeaf.view as MarkdownView;
        const sourceEditor = sourceView.editor;
        const sourceContent = sourceEditor.getValue();
        const refRegex = new RegExp(`\\[\\^${this.escapeRegex(ref)}\\](?!:)`);
        const match = sourceContent.match(refRegex);

        if (match?.index !== undefined) {
            const matchIndex = match.index;
            const startPos = sourceEditor.offsetToPos(matchIndex);
            const endPos = sourceEditor.offsetToPos(matchIndex + match[0].length);
             console.log(`[Highlight] Found ref [^${ref}] at line ${startPos.line + 1}, char ${startPos.ch}`);
            sourceEditor.scrollIntoView({ from: startPos, to: endPos }, true);
            this.clearActiveHighlight();
            sourceEditor.setSelection(startPos, endPos);
            this.activeHighlightTimeout = setTimeout(() => {
                const currentSelection = sourceEditor.listSelections()[0];
                if (currentSelection && this.app.workspace.activeEditor?.editor === sourceEditor &&
                    this.arePositionsEqual(currentSelection.anchor, startPos) &&
                    this.arePositionsEqual(currentSelection.head, endPos)) {
                    sourceEditor.setCursor(startPos);
                }
                this.activeHighlightTimeout = null;
            }, INTERNAL_SETTINGS.highlightDuration);
        } else {
             console.log(`[Highlight] Ref [^${ref}] not found in ${sourceFile.path}.`);
            new Notice(`Reference [^${ref}] not found in "${sourceFile.basename}".`);
        }
    }

    /** アクティブなハイライト解除タイマーをクリア */
    private clearActiveHighlight() {
        if (this.activeHighlightTimeout) {
            clearTimeout(this.activeHighlightTimeout);
            this.activeHighlightTimeout = null;
        }
    }

    /** EditorPositionオブジェクトが等しいか比較 */
    private arePositionsEqual(p1: EditorPosition, p2: EditorPosition): boolean {
        return p1.line === p2.line && p1.ch === p2.ch;
    }

    /** 指定されたLeafでファイルを開く (既存のファイルを開き直す場合など) */
    private async openFileInLeaf(leaf: WorkspaceLeaf, file: TFile, active: boolean): Promise<void> {
        await leaf.openFile(file, { active });
         // console.log(`[Util] Opened ${file.path} in leaf ${leaf.id}, active: ${active}`);
    }


    /** 全てのSourceノートに対して Source -> Cue 同期を実行 */
    async processAllNotesSourceToCue(): Promise<void> {
        const allMarkdownFiles = this.app.vault.getMarkdownFiles();
        let processedCount = 0, skippedDerivedCount = 0, skippedNoCueCount = 0, errorCount = 0;
        const totalFiles = allMarkdownFiles.length;
        const notice = new Notice(`Starting S->C sync for ${totalFiles} notes... 0%`, 0);

        try {
            for (let i = 0; i < totalFiles; i++) {
                const file = allMarkdownFiles[i];
                if (this.isCueNote(file.path) || this.isSummaryNote(file.path)) {
                    skippedDerivedCount++;
                    continue;
                }
                const cuePath = this.getCueNotePath(file);
                const cueFile = this.app.vault.getAbstractFileByPath(cuePath);
                if (!(cueFile instanceof TFile)) {
                    skippedNoCueCount++;
                    continue;
                }
                try {
                    // syncSourceToCue は内部で isSyncing を管理するので、ここではそのまま呼ぶ
                    await this.syncSourceToCue(file);
                    processedCount++;
                } catch (e) {
                    errorCount++;
                    console.error(`[Batch Sync S->C] Error processing ${file.path}:`, e);
                }
                const currentProcessedTotal = processedCount + skippedDerivedCount + skippedNoCueCount;
                if (currentProcessedTotal % INTERNAL_SETTINGS.batchSyncUpdateInterval === 0 || currentProcessedTotal === totalFiles) {
                    const percentage = Math.round((currentProcessedTotal / totalFiles) * 100);
                    const sourceNotesToProcess = totalFiles - skippedDerivedCount - skippedNoCueCount;
                    notice.setMessage(`Syncing S->C... ${percentage}% (${processedCount}/${sourceNotesToProcess > 0 ? sourceNotesToProcess : 'N/A'} sources processed)`);
                    await sleep(5);
                }
            }
            const finalMessage = `Sync (S->C) Complete. Processed: ${processedCount}, Skipped (Derived/No Cue): ${skippedDerivedCount + skippedNoCueCount}, Errors: ${errorCount}. Total Files: ${totalFiles}.`;
            notice.setMessage(finalMessage);
            console.log(finalMessage);
        } catch (e) {
            console.error('[Batch Sync S->C] Fatal error during batch processing:', e);
            notice.setMessage(`Fatal error after processing approx ${processedCount} source notes. Check console.`);
        } finally {
            await this.saveData();
            console.log("[Batch Sync S->C] NoteInfoMap saved after batch sync.");
            setTimeout(() => notice.hide(), 7000);
        }
    }

    /**
     * @deprecated This internal function is now integrated into `syncSourceToCue`.
     */
    private async syncSourceToCueInternal(sf: TFile): Promise<void> {
        console.warn("syncSourceToCueInternal is deprecated and should not be used.");
        await this.syncSourceToCue(sf); // Call the main function instead
    }


	// --- カスタムコードブロックプロセッサ ---
    /** Cueノート内の `cornell-footnote-links` コードブロックを処理 */
    private cornellLinksCodeBlockProcessor = async (
        source: string,
        el: HTMLElement,
        ctx: MarkdownPostProcessorContext
    ) => {
        const currentFilePath = ctx.sourcePath;
        if (!this.isCueNote(currentFilePath)) {
            el.empty();
            return;
        }
        el.empty();

        try {
            const cueFile = this.app.vault.getAbstractFileByPath(currentFilePath);
            if (!(cueFile instanceof TFile)) throw new Error("Current file is not a valid TFile.");
            const cueContent = await this.app.vault.cachedRead(cueFile);
            const footnotesMap = this.parseFootnotesSimple(cueContent);

            if (footnotesMap.size === 0) {
                el.setText("No footnote definitions found in this Cue note.");
                return;
            }

            const sourceNoteFile = this.getSourceNoteFileFromDerived(currentFilePath);
            if (!sourceNoteFile) {
                el.createEl('div', { text: `Error: Corresponding Source note not found. Cannot create navigation links.`, cls: 'cornell-footnote-error' });
                return;
            }

            const buttonContainer = el.createDiv({ cls: 'cornell-footnote-links-container' });
            const sortedRefs = Array.from(footnotesMap.keys()).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

            for (const footnoteRef of sortedRefs) {
                const button = buttonContainer.createEl('button', {
                    text: `[^${footnoteRef}]`,
                    cls: 'cornell-footnote-link-button'
                });
                const definitionPreview = (footnotesMap.get(footnoteRef) || "").substring(0, 100) + ( (footnotesMap.get(footnoteRef) || "").length > 100 ? "..." : "");
                button.setAttribute('title', `[^${footnoteRef}]: ${definitionPreview}\nClick: Navigate to first reference in Source\nCtrl/Cmd+Click: Highlight first reference in Source`);

                this.registerDomEvent(button, 'click', async (event: MouseEvent) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const isModifierPressed = event.ctrlKey || event.metaKey;

                    if (footnoteRef) {
                        if (isModifierPressed && this.settings.enableModifierClickHighlight) { // 設定を確認
                            try { await this.highlightFirstSourceReference(footnoteRef, currentFilePath); }
                            catch (e) { console.error(`[LinksCodeBlock] Error highlighting [^${footnoteRef}]:`, e); new Notice(`Error highlighting reference [^${footnoteRef}].`); }
                        } else if (this.settings.enableCueNoteNavigation) { // 設定を確認
                            try { await this.navigateToSourceReference(footnoteRef, currentFilePath); }
                            catch (e) { console.error(`[LinksCodeBlock] Error navigating to [^${footnoteRef}]:`, e); new Notice(`Error navigating to reference [^${footnoteRef}].`); }
                        }
                    }
                });
            }
        } catch (error) {
            console.error(`[LinksCodeBlock] Error processing footnote links for ${currentFilePath}:`, error);
            el.createEl('div', { text: 'Error rendering footnote links. Check console.', cls: 'cornell-footnote-error' });
        }
    }

} // --- End of Plugin Class ---


// --- 設定タブクラス ---
class CornellFootnoteSettingTab extends PluginSettingTab {
	plugin: CornellFootnotePlugin;

	constructor(app: App, plugin: CornellFootnotePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Cornell Footnote Settings' });
		containerEl.createEl('p', { text: 'Manage footnote synchronization between Source and Cue notes, navigation behavior, and related options.' });

        // --- Synchronization Settings ---
        containerEl.createEl('h3', { text: 'Synchronization' });
        containerEl.createEl('p', {
            text: `Synchronization requires corresponding Cue notes to exist. Use the "Arrange Cornell Notes View" command on a Source note to create/open related notes. Synchronization only happens between Source and Cue notes.`,
            cls:'setting-item-description'
        });

        const syncWarn = containerEl.createDiv({ cls: 'callout', attr: { 'data-callout': 'warning' } });
        syncWarn.createDiv({ cls: 'callout-title', text: 'Warning: Risk with Automatic Sync' });
        syncWarn.createDiv({ cls: 'callout-content' }).createEl('p', { text: 'Enabling automatic sync ("Sync on Save") can potentially lead to unexpected behavior or data loss during complex edits or if files save rapidly. Manual sync commands offer more control and safety. Use auto-sync with caution.' });

		new Setting(containerEl)
            .setName('Enable Automatic Sync on Save')
            .setDesc('Automatically trigger sync when a Source or Cue note is saved. Sync only occurs if the corresponding note exists. Requires caution (see warning above).')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.syncOnSave)
                .onChange(async (value) => {
                    this.plugin.settings.syncOnSave = value;
                    await this.plugin.saveSettings();
                    new Notice(value ? 'Auto Sync Enabled (Use Caution!)' : 'Auto Sync Disabled.');
                }));

        // --- Deletion Settings ---
        const delRefWarn = containerEl.createDiv({ cls: 'callout', attr: { 'data-callout': 'error' } });
        delRefWarn.createDiv({ cls: 'callout-title', text: 'Danger: Automatic Reference Deletion (Cue -> Source)' });
        delRefWarn.createDiv({ cls: 'callout-content' }).createEl('p', { text: 'If enabled, deleting a footnote definition ([^ref]: ...) from the CUE note will automatically delete all corresponding references ([^ref]) in the SOURCE note during Cue -> Source sync. This can lead to IRREVERSIBLE DATA LOSS in the Source note. Use with extreme caution!' });

        new Setting(containerEl)
            .setName('Auto Delete References in Source (Dangerous!)')
            .setDesc('During CUE -> SOURCE sync, if a definition is deleted from the Cue note, automatically remove all corresponding references ([^ref]) from the Source note.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.deleteReferencesOnDefinitionDelete)
                .onChange(async (value) => {
                    if (value) new Notice('DANGER: Automatic Reference Deletion (C->S) enabled! Use with extreme caution.', 10000);
                    else new Notice('Automatic Reference Deletion (C->S) disabled.');
                    this.plugin.settings.deleteReferencesOnDefinitionDelete = value;
                    await this.plugin.saveSettings();
                }));

        const delDefWarn = containerEl.createDiv({ cls: 'callout', attr: { 'data-callout': 'warning' } });
        delDefWarn.createDiv({ cls: 'callout-title', text: 'Warning: Automatic Definition Deletion (Source -> Cue)' });
        delDefWarn.createDiv({ cls: 'callout-content' }).createEl('p', { text: 'If enabled, deleting *all* references ([^ref]) to a specific footnote from the SOURCE note will automatically delete the corresponding definition ([^ref]: ...) from the CUE note during Source -> Cue sync. This also removes the button from the Cue note\'s link block.' });

        new Setting(containerEl)
            .setName('Auto Delete Definition in Cue (on Reference Deletion in Source)')
            .setDesc('During SOURCE -> CUE sync, if all references to a footnote are removed from the Source note, automatically remove the definition from the Cue note.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.deleteDefinitionsOnReferenceDelete)
                .onChange(async (value) => {
                    this.plugin.settings.deleteDefinitionsOnReferenceDelete = value;
                    await this.plugin.saveSettings();
                    new Notice(value ? 'Auto Definition Deletion (S->C) Enabled.' : 'Auto Definition Deletion (S->C) Disabled.');
                }));

        // --- Footnote Positioning Setting ---
        new Setting(containerEl)
            .setName('Move Footnotes to End of Source Note (on C->S Sync)')
            .setDesc('During CUE -> SOURCE sync, automatically gather all footnote definitions ([^ref]: ...) and move them to the very end of the Source note, ensuring a clean separation.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.moveFootnotesToEnd)
                .onChange(async (value) => {
                    this.plugin.settings.moveFootnotesToEnd = value;
                    await this.plugin.saveSettings();
                    new Notice(value ? 'Footnote moving to end (C->S Sync) Enabled.' : 'Footnote moving to end (C->S Sync) Disabled.');
                }));

        // --- Cue Note Interaction Settings (Code Block Buttons) ---
        containerEl.createEl('h3', { text: 'Cue Note Interaction (Code Block Buttons)' });
        containerEl.createEl('p', {
            text: `Configure the behavior of the clickable buttons [\^ref] that appear in the code block (\`\`\`${INTERNAL_SETTINGS.codeBlockProcessorId}\`\`\`) within Cue notes.`,
            cls: 'setting-item-description'
        });

		new Setting(containerEl)
            .setName('Enable Click Navigation (from Cue buttons)')
            .setDesc('Allow single-clicking the buttons in the Cue note\'s code block to navigate to the first corresponding reference in the Source note.')
            .addToggle(t => t // トグルは有効
                .setValue(this.plugin.settings.enableCueNoteNavigation)
                .onChange(async v => { this.plugin.settings.enableCueNoteNavigation = v; await this.plugin.saveSettings(); }));

        new Setting(containerEl)
            .setName('Enable Ctrl/Cmd + Click Highlight (from Cue buttons)')
            .setDesc('Allow Ctrl/Cmd + clicking the buttons in the Cue note\'s code block to highlight the first corresponding reference in the Source note.')
            .addToggle(t => t // トグルは有効
                .setValue(this.plugin.settings.enableModifierClickHighlight)
                .onChange(async v => { this.plugin.settings.enableModifierClickHighlight = v; await this.plugin.saveSettings(); }));

        // --- Link Template Settings ---
        containerEl.createEl('h3', { text: 'Link Templates (for Arrange Command)' });
        containerEl.createEl('p', { text: 'These templates define the links automatically added when the "Arrange Cornell Notes View" command creates new Cue or Summary notes.' , cls:'setting-item-description' });

		new Setting(containerEl)
            .setName('Link to Source Template')
            .setDesc('Template for the link placed in new Cue and Summary notes, pointing back to the Source note. Use {{sourceNote}} as a placeholder for the source note\'s base name.')
            .addText(text => text
                .setPlaceholder(DEFAULT_SETTINGS.linkToSourceText)
                .setValue(this.plugin.settings.linkToSourceText)
                .onChange(async (value) => {
                    this.plugin.settings.linkToSourceText = value || DEFAULT_SETTINGS.linkToSourceText;
                    await this.plugin.saveSettings();
                }));

		new Setting(containerEl)
            .setName('Link to Cue Template')
            .setDesc('Template for the link placed in new Summary notes, pointing back to the Cue note. Use {{cueNote}} as a placeholder for the cue note\'s base name.')
            .addText(text => text
                .setPlaceholder(DEFAULT_SETTINGS.linkToCueText)
                .setValue(this.plugin.settings.linkToCueText)
                .onChange(async (value) => {
                    this.plugin.settings.linkToCueText = value || DEFAULT_SETTINGS.linkToCueText;
                    await this.plugin.saveSettings();
                }));

        // --- Internal Settings (Read-Only) ---
        containerEl.createEl('h3', { text: 'Internal Configuration (Read-Only)' });
        containerEl.createEl('p', { text: 'These settings are fixed internally and cannot be changed:'});
        const internalList = containerEl.createEl('ul');
        internalList.createEl('li', { text: `Cue Note Suffix: ${INTERNAL_SETTINGS.cueNoteSuffix}.md`});
        internalList.createEl('li', { text: `Summary Note Suffix: ${INTERNAL_SETTINGS.summaryNoteSuffix}.md`});
        internalList.createEl('li', { text: `Note Location: Cue/Summary notes are created in the same folder as their Source note.`});
        internalList.createEl('li', { text: `Code Block ID for Cue interaction: ${INTERNAL_SETTINGS.codeBlockProcessorId}`});
        internalList.createEl('li', { text: `Sync Debounce Time: ${INTERNAL_SETTINGS.syncDebounceTime}ms`});

        // --- Manual Commands Info ---
        containerEl.createEl('h3', { text: 'Available Commands' });
        containerEl.createEl('p', { text: 'Use the Command Palette (Ctrl/Cmd+P) or assign hotkeys to these commands:' });
        const cmdList = containerEl.createEl('ul');
        cmdList.createEl('li', { text: '"Manual Sync: Source -> Cue": Updates the Cue note from the current Source note (Cue must exist).' });
        cmdList.createEl('li', { text: '"Manual Sync: Cue -> Source": Updates the Source note from the current Cue note (run from Cue note).' });
        cmdList.createEl('li').createEl('code', { text: 'Sync All Notes (Source -> Cue)' });
        cmdList.createEl('li', { text: '"Arrange Cornell Notes View": Opens Source, Cue, and Summary notes in a split layout (creates Cue/Summary if needed, run from Source note).' });
        cmdList.createEl('li', { text: '"Highlight First Reference in Source (from Cue def/cursor)": Highlights the first [^ref] in Source (run from definition or button in Cue note).' });
	}
}

// --- Utility Functions ---
/** 指定ミリ秒待機する Promise を返す */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}