# CourseHelper · 课程助手

在学习通、雨课堂网页右下角，直接控制 **0.5–4 倍速、播放 / 暂停、自动下一节**，也可以接入自己的兼容 API，**自动做本页题目、填写并提交**。

普通用户无需安装 Node.js，也不用每次打开浏览器扩展菜单。

## 推荐安装：脚本版

1. 从 [Tampermonkey 官网](https://www.tampermonkey.net/index.php?browser=edge) 进入浏览器商店，安装一次 Tampermonkey。
2. 打开仓库中的 [course-helper.user.js](userscript/course-helper.user.js)，点击 **Raw**，在脚本管理器页面确认安装。也可使用 Release 的同名附件。
3. 刷新学习通或雨课堂，使用右下角的 **课程助手**。

部分浏览器还需要为脚本管理器开启“允许用户脚本”或开发者模式；按脚本管理器提示完成一次授权即可。若附件只被下载，可在 Tampermonkey 的“实用工具”中导入。详见 [脚本安装指南](docs/INSTALL_USERSCRIPT.md)。仓库正式发布后，作者可将真实 Raw 地址设为首页安装链接。

## 两种版本怎么选

| | 脚本版（推荐） | 浏览器扩展版 |
| --- | --- | --- |
| 首次安装 | 装一次 Tampermonkey，再安装 `.user.js` | 解压 ZIP，在扩展页加载目录 |
| 日常操作 | 课程页右下角面板 | 同样的页面面板，另有工具栏弹窗 |
| 更新 | 再打开脚本安装链接；配置更新地址后可由管理器检查更新 | 替换文件，重新加载扩展并刷新课程页 |
| API 配置 | 保存在脚本管理器中 | 保存在扩展本地存储中 |

只启用其中一个版本，避免两个控制器同时操作播放器。两个版本的 API 设置不会互相同步。

扩展版安装包为 `course-helper-v0.3.0.zip`。如果下载整个仓库，加载里面的 **`extension/`**，不要加载源码根目录。完整步骤见 [使用指南](docs/USER_GUIDE.md)。

## 使用

**看视频：** 打开具体视频章节，在面板选择倍速并点击“开始 / 继续”。需要连播时勾选“自动下一节”；暂停可在面板或网页播放器中操作。

**AI 做题：** 首次点击“API 设置”，填写兼容 Chat Completions 的地址、密钥与模型，保存并测试。打开具体题目页，点击“AI 做本页题”。默认自动填写并提交，也可以关闭自动提交，或只生成答案。

提交前会检查题目是否完整识别、答案是否全部填写、页面快照是否变化以及提交按钮是否唯一；不能确认时停止并提示。停止任务不会回滚已经填写或提交的内容。AI 答案不保证正确，提交结果以平台页面为准。

题干、选项会发送给你配置的 API 服务，可能产生费用。视频控制不需要 API；密钥无需发给项目作者。详见 [隐私说明](PRIVACY.md)。

## 支持范围

- 电脑上的 Edge / Chrome；HTTPS 的 `chaoxing.com`、`yuketang.cn` 及其子域名。
- 页面里的 HTML5 视频；倍速修改真实播放速度，不伪造时长或上报进度，平台仍可能限制速度。
- 已适配目录中的自动下一节；遇到未完成任务、锁定内容或无法识别的目录会停止。
- 可识别的单选、多选、判断和文本题。图片题、复杂公式、未知控件或页面变化可能导致跳过；存在跳过题目时不自动提交。

需要先进入课程或题目页并主动启动。助手不自动登录、不自动开始尚未进入的考试、不绕过平台验证，也不直接调用平台进度接口。跨域播放器的父目录、学校独立域名和新版题目布局可能需要单独适配。

## 验证与开发

测试使用脱敏题目 fixtures、模拟媒体与模拟 API，覆盖倍速、播放状态、题目识别、填写提交保护、API 错误与取消、跨框架路由和界面交互。真实账号与用户自己的 API 尚未完成完整验收，不能把自动化通过等同于所有平台页面均可用。详见 [测试记录](docs/TESTING.md)。

维护者安装符合 `package.json` 的 Node.js（推荐 Node.js 24），执行：

```sh
npm ci
npm run verify
npm run package:source
```

常用命令：

```sh
npm run check            # TypeScript 类型检查
npm test                 # 自动化回归
npm run build            # 构建浏览器扩展
npm run build:userscript # 构建脚本版
npm run package          # 生成扩展 ZIP 与脚本附件
npm run package:source   # 生成干净的 GitHub 源码归档
node scripts/preview.mjs # 本机浏览器测试页，无需账号或真实 API
```

`controller.ts` 是共享页面控制器；`quiz.ts` 处理题目；`api.ts` 请求用户服务；`background.ts` / `quiz-jobs.ts` 负责扩展路由与任务；`userscript.ts` 提供脚本运行方式；`ui.ts` 是共享面板。请修改源文件后构建，不要直接改生成的脚本。

## 发布

随源码提交 `extension/` 与 `userscript/`，让用户无需编译。推送与 manifest 一致的版本标签（如 `v0.3.0`）后，Release 工作流验证并上传扩展 ZIP 和 `course-helper.user.js`。

`dist/course-helper-source-v0.3.0.zip` 是干净源码归档。解压后提交里面的文件，不要只上传 ZIP 代替源码。不要上传密钥、个人截图、浏览器资料或 `node_modules/`。

作者配置脚本稳定 Raw 地址后可简化更新；扩展版也可后续送审 Edge 商店。详见 [发布指南](docs/PUBLISHING.md)。这些文件不代表已通过 Edge 商店审核。

## 许可证

Copyright (C) 2026 Geng0214

本项目以 [GNU General Public License v3.0](LICENSE)（GPL-3.0）发布，许可证全文见 `LICENSE`。

你可以自由地使用、修改和分发本项目，包括商业使用；但分发本项目或其衍生作品时，必须以 GPL-3.0 同样授权、公开对应源码，并保留原始版权声明。本项目按“现状”提供，不附带任何明示或暗示的担保。
