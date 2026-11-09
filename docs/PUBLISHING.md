# GitHub 与扩展商店发布指南

`0.3.0` 推荐脚本安装入口，同时提供扩展 ZIP；普通用户无需构建。

## 仓库与验证

提交源码、锁文件、图标、测试、文档、工作流，以及 `extension/` 和 `userscript/course-helper.user.js`。不要上传密钥、浏览器资料、真实账号截图、依赖目录、环境文件或旧 ZIP。

维护者运行：

```sh
npm ci
npm run verify
npm run package:source
```

| 产物 | 用途 |
| --- | --- |
| `dist/course-helper.user.js` | 推荐给用户的脚本附件 |
| `userscript/course-helper.user.js` | 随仓库提交，生成 Raw 安装链接 |
| `dist/course-helper-v0.3.0.zip` | 扩展版，解压后加载 |
| `dist/course-helper-source-v0.3.0.zip` | 干净源码归档，解压后提交其中的文件 |

提交最新生成文件，避免源码和安装版本不一致。源码 ZIP 不应代替仓库内容。旧的 `courseHelper.zip`、`rainClassroom.zip` 不继续作为安装附件。仓库名称、可见性和许可证由作者决定，公开前添加合适的 `LICENSE`。

## 设置更简单的安装入口

1. 发布自己的仓库，打开 `userscript/course-helper.user.js`，复制真实 **Raw** 地址。
2. 在已装 Tampermonkey 的浏览器确认它可打开脚本安装页。
3. 将真实地址放到 README 顶部“安装脚本”链接，保留首次安装 Tampermonkey 的说明。

地址应返回脚本文件，而非 GitHub HTML 预览页。Release 附件若仅触发下载，保留管理器导入说明。不要宣传为无需任何浏览器授权。

需自动更新时，在本地构建环境设置 `COURSE_HELPER_UPDATE_URL` 为自己稳定、公开、以 `.user.js` 结尾的 HTTPS 地址。同时在 GitHub 仓库的 Settings → Secrets and variables → Actions → Variables 添加同名变量，值与本地一致；两个工作流已经读取它。构建器写入 `@downloadURL` / `@updateURL`；重新构建并提交生成文件，保证 CI 产物一致。未配置时不填虚假地址，用户可重新打开安装链接更新。详见 [脚本安装指南](INSTALL_USERSCRIPT.md)。

## Release

`ci.yml` 验证类型、测试与两种构建产物；`release.yml` 在推送 `v*` 标签后检查版本，成功才创建 Release，上传扩展 ZIP 和 `.user.js`。

代码已提交并推送到自己的仓库后：

```sh
git tag v0.3.0
git push origin v0.3.0
```

推送会触发发布。到 Actions 查看结果，再确认 Releases 的两个附件。标签与 manifest 必须一致。下一版同步提高 manifest、package、锁文件版本，重新构建并使用新标签。手动 Release 与标签自动发布二选一，避免重复创建。

发布说明应包含安装入口、变更、API 配置、自动提交默认值、联网和费用说明，以及 [测试记录](TESTING.md) 中的真实范围。模拟测试通过不能表述为所有真实课程均已验收。

## 可选：Edge Add-ons 商店

商店可让用户直接安装并由浏览器获取更新。作者需要 Partner Center 账号、扩展 ZIP、真实截图、权限说明、隐私政策与可复现的测试步骤。参见 [Microsoft 发布流程](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)。

送审材料应如实说明倍速、用户自配 API 做题、题干选项发送、密钥本地保存，以及 `webNavigation`、`storage` 和可选域名权限。截图不要暴露账号和密钥，不宣称保证答对或绕过平台限制。

审核通过后再加入真实商店链接；更新需提高版本并重新提交，参见 [Microsoft 更新说明](https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/update-extension)。项目本地文件和工作流不代表已经发布或通过审核。
