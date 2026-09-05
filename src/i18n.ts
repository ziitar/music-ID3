import { useSyncExternalStore } from "react";

export type Locale = "zh-CN" | "en-US";

const storageKey = "music-id3.locale";

const en = {
  appTitle: "Music Library",
  scanFolder: "Scan folder",
  settings: "Settings",
  language: "Language",
  simplifiedChinese: "Simplified Chinese",
  english: "English",
  directories: "Directories",
  chooseFolder: "Choose folder",
  noFolderSelected: "No folder selected",
  libraryDirectories: "Library directories",
  allFiles: "All files",
  scanning: "Scanning...",
  cancel: "Cancel",
  library: "Library",
  itemCount: "{count} items",
  librarySearch: "Library search",
  searchLibrary: "Search library",
  formatFilter: "Format filter",
  allFormats: "All formats",
  statusFilter: "Status filter",
  allStatuses: "All statuses",
  statusNormal: "Normal",
  statusSuspected: "Suspected",
  statusOverridden: "Overridden",
  statusMissing: "Missing CUE refs",
  statusError: "Error",
  scanToBegin: "Scan a folder to begin.",
  noFilesMatch: "No files match this view.",
  details: "Details",
  selectFile: "Select a file to inspect.",
  suspectedCue: "Suspected whole-track CUE. Use the whole-track CUE candidate flow.",
  normalAudioEditing: "Use normal audio editing",
  commonTags: "Common tags",
  rawTags: "Raw tags",
  rawTagsReadOnly: "raw tags read only",
  coverPreview: "cover preview",
  noCover: "No cover",
  noCoverSelected: "No cover selected",
  removeCover: "Remove cover",
  replaceCover: "Replace cover",
  coverFile: "cover file",
  unsupported: "unsupported",
  previewDiff: "Preview diff",
  writeSelectedFields: "Write selected fields",
  clearCoverQuestion: "Clear cover art?",
  confirmClear: "Confirm clear",
  confirmWriteQuestion: "Confirm writing selected fields?",
  confirmWrite: "Confirm write",
  metadataCandidates: "Metadata candidates",
  provider: "Provider",
  candidateQuery: "Candidate query",
  search: "Search",
  searching: "Searching...",
  noCandidates: "No candidates found.",
  unknownArtist: "Unknown artist",
  candidateCover: "candidate cover",
  loadCandidateDetails: "Load candidate details",
  applyCandidate: "Apply candidate",
  reviewChanges: "Review selected changes before writing.",
  confirmCandidateWrite: "Confirm candidate write",
  cueEditor: "CUE editor",
  source: "Source",
  localCue: "local CUE",
  confidence: "Confidence",
  releaseId: "Release ID",
  discId: "Disc ID",
  inferredCandidate: "Inferred candidate",
  missingReferences: "Missing references",
  structured: "Structured",
  raw: "Raw",
  encoding: "Encoding",
  sourcePreviews: "Source previews",
  decodeAs: "Decode as {encoding}",
  rawCue: "raw cue",
  albumTitle: "Album title",
  albumPerformer: "Album performer",
  track: "Track {number}",
  title: "Title",
  artist: "Artist",
  album: "Album",
  albumArtist: "Album artist",
  trackNumber: "Track number",
  trackTotal: "Total tracks",
  discNumber: "Disc number",
  discTotal: "Total discs",
  date: "Date",
  genre: "Genre",
  composer: "Composer",
  comment: "Comment",
  lyrics: "Lyrics",
  copyright: "Copyright",
  cover: "Cover",
  performer: "Performer",
  pregap: "Pregap",
  postgap: "Postgap",
  saveCue: "Save CUE",
  createsNewCue: "This creates a new CUE file.",
  createsBackup: "Saving creates a .bak backup.",
  reviewLowConfidence: "Review this inferred, low-confidence candidate before saving.",
  confirmCueSave: "Confirm CUE save",
  providerLabel: "Provider",
  cookieProvider: "Cookie provider",
  pasteCookie: "Paste Cookie",
  saveCookie: "Save Cookie",
  test: "Test",
  clear: "Clear",
  cookieStatus: "Cookie status",
  configured: "configured",
  unconfigured: "unconfigured",
  clearOnlineCache: "Clear online cache",
  confidenceHigh: "high",
  confidenceMedium: "medium",
  confidenceLow: "low",
  confidenceUnverified: "unverified"
} as const;

type MessageKey = keyof typeof en;

const zh = {
  appTitle: "音乐资料库",
  scanFolder: "扫描文件夹",
  settings: "设置",
  language: "语言",
  simplifiedChinese: "简体中文",
  english: "English",
  directories: "文件夹",
  chooseFolder: "选择文件夹",
  noFolderSelected: "尚未选择文件夹",
  libraryDirectories: "资料库文件夹",
  allFiles: "全部文件",
  scanning: "正在扫描...",
  cancel: "取消",
  library: "资料库",
  itemCount: "{count} 项",
  librarySearch: "搜索资料库",
  searchLibrary: "搜索资料库",
  formatFilter: "格式筛选",
  allFormats: "全部格式",
  statusFilter: "状态筛选",
  allStatuses: "全部状态",
  statusNormal: "正常",
  statusSuspected: "疑似整轨",
  statusOverridden: "已允许编辑",
  statusMissing: "CUE 引用缺失",
  statusError: "错误",
  scanToBegin: "请先扫描一个文件夹。",
  noFilesMatch: "没有符合当前条件的文件。",
  details: "详细信息",
  selectFile: "请选择一个文件查看详情。",
  suspectedCue: "此文件疑似整轨 CUE 音频，请使用整轨 CUE 候选流程。",
  normalAudioEditing: "仍按普通音频编辑",
  commonTags: "常用标签",
  rawTags: "原始标签",
  rawTagsReadOnly: "只读原始标签",
  coverPreview: "封面预览",
  noCover: "无封面",
  noCoverSelected: "尚未选择封面",
  removeCover: "移除封面",
  replaceCover: "替换封面",
  coverFile: "封面文件",
  unsupported: "不支持",
  previewDiff: "预览更改",
  writeSelectedFields: "写入所选字段",
  clearCoverQuestion: "确定移除封面吗？",
  confirmClear: "确认移除",
  confirmWriteQuestion: "确定写入所选字段吗？",
  confirmWrite: "确认写入",
  metadataCandidates: "元数据候选",
  provider: "数据源",
  candidateQuery: "候选搜索词",
  search: "搜索",
  searching: "正在搜索...",
  noCandidates: "未找到候选结果。",
  unknownArtist: "未知艺术家",
  candidateCover: "候选封面",
  loadCandidateDetails: "加载候选详情",
  applyCandidate: "应用候选",
  reviewChanges: "写入前请检查所选更改。",
  confirmCandidateWrite: "确认写入候选信息",
  cueEditor: "CUE 编辑器",
  source: "来源",
  localCue: "本地 CUE",
  confidence: "置信度",
  releaseId: "发行版本 ID",
  discId: "光盘 ID",
  inferredCandidate: "推断的候选结果",
  missingReferences: "缺失引用",
  structured: "结构化",
  raw: "原始文本",
  encoding: "编码",
  sourcePreviews: "源文件预览",
  decodeAs: "使用 {encoding} 解码",
  rawCue: "原始 CUE 文本",
  albumTitle: "专辑标题",
  albumPerformer: "专辑表演者",
  track: "音轨 {number}",
  title: "标题",
  artist: "艺术家",
  album: "专辑",
  albumArtist: "专辑艺术家",
  trackNumber: "音轨编号",
  trackTotal: "音轨总数",
  discNumber: "光盘编号",
  discTotal: "光盘总数",
  date: "日期",
  genre: "流派",
  composer: "作曲者",
  comment: "备注",
  lyrics: "歌词",
  copyright: "版权",
  cover: "封面",
  performer: "表演者",
  pregap: "前置间隙",
  postgap: "后置间隙",
  saveCue: "保存 CUE",
  createsNewCue: "这将创建一个新的 CUE 文件。",
  createsBackup: "保存时将创建 .bak 备份。",
  reviewLowConfidence: "保存前请检查这个置信度较低的推断候选结果。",
  confirmCueSave: "确认保存 CUE",
  providerLabel: "服务商",
  cookieProvider: "Cookie 服务商",
  pasteCookie: "粘贴 Cookie",
  saveCookie: "保存 Cookie",
  test: "测试",
  clear: "清除",
  cookieStatus: "Cookie 状态",
  configured: "已配置",
  unconfigured: "未配置",
  clearOnlineCache: "清除在线缓存",
  confidenceHigh: "高",
  confidenceMedium: "中",
  confidenceLow: "低",
  confidenceUnverified: "未验证"
} satisfies Record<MessageKey, string>;

const knownChineseMessages: Record<string, string> = {
  "Unable to cancel previous scan": "无法取消上一次扫描",
  "Unable to select a folder": "无法选择文件夹",
  "Unable to scan this folder": "无法扫描此文件夹",
  "Unable to change whole-track editing mode": "无法更改整轨编辑模式",
  "Scan cancelled": "扫描已取消",
  "Unable to cancel scan": "无法取消扫描",
  "Unable to refresh audio metadata": "无法刷新音频元数据",
  "Unable to refresh CUE": "无法刷新 CUE",
  "Unable to load candidate details": "无法加载候选详情",
  "CUE candidate needs a referenced audio file": "CUE 候选需要一个引用的音频文件",
  "Unable to build candidate CUE": "无法生成候选 CUE",
  "No applicable candidate fields selected": "未选择可用的候选字段",
  "Unable to write audio metadata": "无法写入音频元数据",
  "Unable to save CUE": "无法保存 CUE",
  "Metadata search failed": "元数据搜索失败",
  "Unable to read cover image": "无法读取封面图片",
  "Unable to validate CUE text": "无法验证 CUE 文本",
  "Unable to decode CUE with the selected source encoding": "无法使用所选源编码解码 CUE",
  "Unable to prepare CUE save": "无法准备保存 CUE",
  "Validate edited CUE before saving": "保存前请先验证编辑后的 CUE",
  "Unable to load Cookie status": "无法加载 Cookie 状态",
  "Unable to save Cookie": "无法保存 Cookie",
  "Connection successful": "连接成功",
  "Cookie test failed": "Cookie 测试失败",
  "Unable to clear Cookie": "无法清除 Cookie",
  "Online cache cleared": "在线缓存已清除",
  "Unable to clear online cache": "无法清除在线缓存",
  "No Cookie configured": "尚未配置 Cookie",
  "Provider is not configured": "服务商尚未配置",
  "Provider connectivity check failed": "服务商连接检查失败",
  "Cover art unavailable": "无法获取封面",
  "CTDB validation unavailable": "CTDB 验证不可用",
  "CTDB returned no matching pressing": "CTDB 未找到匹配的发行版本",
  "CTDB verified the pressing": "CTDB 已验证该发行版本",
  "QQ Music song result": "QQ 音乐歌曲结果",
  "NetEase song result": "网易云音乐歌曲结果",
  "Track count matched": "音轨数量匹配",
  "musicbrainz release": "MusicBrainz 发行版本"
};

function initialLocale(): Locale {
  try {
    const stored = globalThis.localStorage?.getItem(storageKey);
    if (stored === "zh-CN" || stored === "en-US") return stored;
  } catch {
    // Storage can be unavailable in hardened renderer contexts.
  }
  return "zh-CN";
}

let locale = initialLocale();
const listeners = new Set<() => void>();

function applyDocumentLocale(next: Locale): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = next;
  document.title = messages[next].appTitle;
}

const messages: Record<Locale, Record<MessageKey, string>> = { "zh-CN": zh, "en-US": en };

export function getLocale(): Locale {
  return locale;
}

export function setLocale(next: Locale): void {
  locale = next;
  try { globalThis.localStorage?.setItem(storageKey, next); } catch { /* Keep the in-memory preference. */ }
  applyDocumentLocale(next);
  listeners.forEach((listener) => listener());
}

export function translate(key: MessageKey, values: Record<string, string | number> = {}): string {
  return Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), messages[locale][key]);
}

export function translateKnownMessage(message: string): string {
  if (locale !== "zh-CN") return message;
  const exact = knownChineseMessages[message];
  if (exact) return exact;
  if (message === "netease release") return "网易云音乐发行版本";
  if (message === "qq release") return "QQ 音乐发行版本";
  if (/connectivity failed$/i.test(message)) return `${message.replace(/ connectivity failed$/i, "")} 连接失败`;
  if (/returned no song details$/i.test(message)) return "服务商未返回歌曲详情";
  if (/returned no matching pressing$/i.test(message)) return "未找到匹配的发行版本";
  return message;
}

export function useI18n() {
  const activeLocale = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    getLocale,
    getLocale
  );
  return {
    locale: activeLocale,
    setLocale,
    t: (key: MessageKey, values?: Record<string, string | number>) => translate(key, values),
    translateMessage: translateKnownMessage
  };
}

applyDocumentLocale(locale);
