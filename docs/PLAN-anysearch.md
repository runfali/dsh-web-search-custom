# 升级计划：适配 AnySearch（v0.2.0）

状态：已获批准（方案 A）· 2026-09-21

## 目标

让 dsh-web-search-custom 的出厂默认指向 AnySearch，并支持「带 key 走鉴权配额、不带 key 走匿名免费额度」。

## 实测事实（2026-09-21，本机）

- 旧默认端点内网 SearXNG \`10.200.0.5:8080\` 已搜不出结果（baidu/bing/sogou/startpage/wikipedia 全 timeout），\`web_search\` 返回空 sources。
- AnySearch：\`POST https://api.anysearch.com/v1/search\`，匿名（不带 Authorization）HTTP 200、1.6–2.1s；直连与走代理都通；\`max_results\` 上限 10（传 20/0 均返回 10）；错误 key → 401；未知 tag → 400；\`tag/params/zone/language\` 可选、不传即自动路由。
- 非 200 错误体：\`{code:-1,message,request_id[,error_code]}\`；402 可能回吐自动生成的凭据（username/password/api_key）。

## 设计

1. 新增 \`api\` 字段：\`auto\`（默认）| \`anysearch\` | \`generic\`。auto 按生效 URL 主机名判定（\`*.anysearch.com\` → anysearch）。
2. 新增 \`maxResults\` 字段：anysearch 档发送 \`max_results\`，取 \`min(配置值, 调用方 maxResults)\` 并夹在 1..10。
3. 出厂默认 URL 改为 \`https://api.anysearch.com/v1/search\`（免 key 匿名可用）。
4. anysearch 档：固定 POST + \`{"query","max_results"}\`（**原始 query，不做 URL 编码**）；鉴权 \`Authorization: Bearer <key>\`，**key 为空则完全不发该头**（匿名档）；响应按厂商信封映射 \`data.results[].{title,url,snippet}\uff08snippet 缺失回落 content\uff09\`；非 200 或 \`code !== 0\` 抛错并带 \`message\` + \`request_id\` + 处置提示；402 的自动生成凭据块脱敏后再抛（不落盘敏感值）。
5. generic 档：现有行为一字不动（GET/POST 模板、authHeader/authScheme、字段映射）；模板层新增 \`{queryRaw}\`（未编码），\`{query}\` 语义不变；顺带修 POST body 里 query 被 URL 编码的真 bug。
6. 字段作用域（写进设置卡提示与 README）：anysearch 档只认 url/apiKey/headers/timeoutMs/maxResults；method/body/authHeader/authScheme/字段映射四件套仅 generic 档生效。tag/params/zone/language 不单开字段，需要时用 \`api: generic\` + body 模板表达（README 给现成示例）。

## 交付物

- \`src/index.js\`、\`lib/client.js\`、\`cordis.patch.yml\`、\`package.json\`（0.2.0）、README 双语、docs/AUDIT.md + docs/EVIDENCE.md
- 测试：entry.test.mjs（anysearch 映射/鉴权/错误/auto 判定/{queryRaw}）、entry-smoke、host-integration（真宿主全链路）、client-smoke（15 字段）、live-search（真端点）

## 用户侧收尾（沙箱外）

\`~/.dsh/settings.yaml\` 用户层仍钉着旧 SearXNG URL → 需在「设置 → 插件配置」点搜索 URL 的「重置」+保存，或手删该键；改完重启 dsh 生效。

