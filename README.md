# NeepWords Mobile · 考研英语大纲词库（手机版）

把开源项目 [elanzuo/NeepWords](https://github.com/elanzuo/NeepWords) 的本地词库工具搬到了手机上。

同一个应用本体，两种用法：

| 形态 | 说明 |
| --- | --- |
| **网页版（PWA）** | 手机浏览器打开即用，可「添加到主屏幕」变独立图标，**断网也能查** |
| **安卓版（APK）** | Capacitor 套壳，由 GitHub Actions 云端构建，本机无需 Android 环境 |

## 拿到 APK

1. 打开本仓库 **Actions** 标签页
2. 点左侧 **Build Android APK**
3. 选最新一次成功运行，在页面底部 **Artifacts** 下载 `NeepWords-APK`
4. 解压得到 `NeepWords-考研词库-v1.0.0.apk`，传到手机安装

> 首次构建约 3–6 分钟。也可以在 Actions 页面点 **Run workflow** 手动触发。

安装时 Android 会提示「未知来源」，因为这是 debug 签名包 —— 允许即可。
自己编译自用的正常现象，不是文件损坏。

## 从原项目继承了什么

| 原项目能力 | 实现方式 | 本应用对应功能 |
| --- | --- | --- |
| `neep_vocab.py lookup` 大纲归属判断 | 复刻同一套输入规范化与判定逻辑 | 「查词」页，一次最多 200 词 |
| `neep_vocab.py search` 五种检索模式 | 复刻 CLI 的 LIKE 语义 | 「检索」页，带分页与整页收藏 |
| `neep_vocab.py list-versions` 版本信息 | 词库元数据内置 | 「我的」页词库信息 |
| `vocab_sheet.py` A4 背诵表 | 浏览器打印排版（横版 A4） | 「词表」页勾选生成，含 D0–D30 打勾栏 |
| OCR 提取入库（`word_extractor`） | 依赖 macOS Apple Vision 框架 | **未移植** |

新增的移动端功能：生词本、间隔复习听写（TTS 朗读 + 拼写判定）、学习数据导入导出、深浅色主题。

## 项目结构

```
.
├── index.html                  # 应用入口（5 个标签页）
├── assets/
│   ├── styles.css              # 移动优先样式，含浅色/深色主题与打印样式
│   └── app.js                  # 全部逻辑：解析、检索、生词本、复习调度、听写
├── data/
│   ├── vocab.js                # 词库数据包（5624 词，约 140 KB）
│   └── vocab.report.json       # 提取报告：字母/页码分布、OCR 可疑词
├── icons/                      # 192/432/512/maskable/apple-touch 图标
├── www/                        # ← 打包进 APK 的 web 目录
├── capacitor.config.json       # Capacitor 配置
├── package.json                # Capacitor 8 依赖
└── .github/workflows/
    └── build-apk.yml           # 云构建工作流
```

`www/` 是从上面那几项复制生成的 —— 改源文件后跑一次同步，别单独改 `www/`。

## 本机运行

不需要任何构建工具，起个静态服务器就行：

```bash
python -m http.server 8765
# 打开 http://127.0.0.1:8765
```

> 不能直接双击 `index.html` —— Service Worker 和 PWA 需要 http 协议。

## 本机构建 APK（可选，需要 Android 环境）

前提：JDK 21、Android SDK（platform 35 + build-tools 35.0.0）。

```bash
npm install
npx cap add android        # 首次
npx cap sync android       # 每次改完网页代码
cd android && ./gradlew assembleDebug
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

## 词库数据

- **来源**：上游仓库内置只读示例库 `skills/kaoyan-vocab-lookup/examples/words.sqlite3`
- **版本**：2026 考研英语（一）考试大纲词汇，共 **5624** 词，P45–P165
- **定位标记**：每词保留原始 OCR 坐标，格式 `<前缀>-<页>-<栏>-<行>-<原始识别词>`，
  例如 `26考研英语一考试大纲-156-L-19-transition`
- **不含中文释义**：原词库只有词表。应用内「在线释义」按钮在点击时请求免费词典接口，
  本应用自身不内置、也不编造释义。

### OCR 质量提示（12 条）

原数据来自扫描版大纲的 OCR，以下 12 条疑似分栏误切或断字。应用内标记为「待核对」，
**不影响查词，也不做静默修改**，且不进入听写抽题池：

`favo rite`、`flavo r`、`flavo ur`、`instal ment`、`maths)`、`o clock`、`p rate`、
`r sum`、`sk ll`、`skil ful`、`skill ful`、`slight b`

## 更新词库

上游 OCR 提取依赖 macOS，本应用不含该能力。需要更新时：

1. 在上游项目用 macOS 跑提取，得到新的 `words.sqlite3`
2. 放进 `skills/kaoyan-vocab-lookup/examples/`
3. 跑 `tools/extract_vocab.py` 重新生成 `data/vocab.js`

## 隐私

生词本、复习进度、设置全部存在**本机**（网页版为 localStorage，安卓版为 WebView 存储），
不上传任何服务器。「在线释义」是唯一联网功能，仅在点击时请求。

## 许可与边界

- 软件代码遵循 MIT 许可（同上游项目）。
- 词表数据版权归考试大纲发布方所有，仅供个人学习检索使用，请勿二次分发。
